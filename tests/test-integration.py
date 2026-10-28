#!/usr/bin/env python3
"""以真实 CCR + 本机假上游做 HTTP 回归；HOME、端口、补丁文件均隔离。"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request

BR = Path(__file__).resolve().parent.parent


class Upstream(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        type(self).requests.append(request)
        model = request.get('model')
        if model == 'bad-json':
            body = b'{not JSON}'
        elif model in ('sse', 'wrong-label-sse'):
            chunks = [dict(id='mock-id', model=model, choices=[dict(index=0, delta=dict(content='EXPECTED_ANSWER'), finish_reason=None)]),
                      dict(id='mock-id', model=model, choices=[dict(index=0, delta={}, finish_reason='stop')], usage=dict(prompt_tokens=2, completion_tokens=3))]
            body = ''.join('data: ' + json.dumps(c) + '\n\n' for c in chunks).encode() + b'data: [DONE]\n\n'
        else:
            body = json.dumps(dict(id='mock-id', model=model, choices=[dict(index=0, message=dict(role='assistant', content='EXPECTED_ANSWER'), finish_reason='stop')], usage=dict(prompt_tokens=2, completion_tokens=3))).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if model == 'sse' else 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='ccr-http-regression-', dir=os.environ['TMPDIR']) as tmp:
            base = Path(tmp)
            cli = base / 'node_modules/@musistudio/claude-code-router/dist/cli.js'
            cli.parent.mkdir(parents=True)
            for name in ['@fastify', '@isaacs', 'fastify', 'ajv', 'fast-uri', 'find-my-way', 'undici', 'minimatch', 'glob', 'shell-quote']:
                (base / 'node_modules' / name).symlink_to(BR / 'node_modules' / name, target_is_directory=True)
            original = BR / 'node_modules/@musistudio/claude-code-router/dist'
            shutil.copy2(original / 'cli.js', cli)
            shutil.copy2(original / 'tiktoken_bg.wasm', cli.parent / 'tiktoken_bg.wasm')
            shutil.copy2(BR / 'runtime/patch-ccr.js', base / 'patch-ccr.js')
            patched = subprocess.run(['node',str(base/'patch-ccr.js')],capture_output=True,text=True,timeout=20)
            assert patched.returncode in [0,2], patched.stderr
            home = base / 'home'
            state = home / '.claude-code-router'
            state.mkdir(parents=True)
            with socket.socket() as s:
                s.bind(('127.0.0.1', 0))
                port = s.getsockname()[1]
            models = ['json', 'sse', 'wrong-label-sse', 'bad-json']
            config = dict(HOST='127.0.0.1',PORT=port,LOG=False,APIKEY='test-only',
                          NON_INTERACTIVE_MODE=True,
                          Providers=[dict(name='mock',api_base_url=f'http://127.0.0.1:{upstream.server_port}/chat/completions',api_key='test-only',models=models)],
                          Router=dict(default='mock,json'))
            (state/'config.json').write_text(json.dumps(config))
            env = os.environ.copy()
            env['HOME'] = str(home)
            for k in ['CCAPP_RUN','CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy','SERVICE_PORT']:
                env.pop(k,None)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with (base/'bridge.out').open('w+') as log:
                p = subprocess.Popen(['node',str(cli),'start'],cwd=base,env=env,stdout=log,stderr=log,start_new_session=True)
                try:
                    for _ in range(100):
                        try:
                            with opener.open(f'http://127.0.0.1:{port}/health',timeout=.4) as r:
                                if r.status == 200:
                                    break
                        except OSError:
                            pass
                        if p.poll() is not None:
                            log.seek(0)
                            raise AssertionError('isolated CCR exited: '+log.read())
                        time.sleep(.1)
                    else:
                        raise AssertionError('isolated CCR readiness timeout')
                    count = 0
                    for model,stream in [('json',False),('json',True),('sse',True),('wrong-label-sse',True)]:
                        body = json.dumps(dict(model='mock,'+model,max_tokens=32,stream=stream,messages=[dict(role='user',content='local test')])).encode()
                        req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/messages',data=body,
                                                     headers={'Content-Type':'application/json','x-api-key':'test-only','anthropic-version':'2023-06-01'})
                        try:
                            with opener.open(req,timeout=8) as r:
                                data = r.read().decode()
                                assert r.status == 200
                                assert 'EXPECTED_ANSWER' in data, data
                                if stream:
                                    assert 'message_start' in data and 'message_stop' in data, data
                                else:
                                    assert json.loads(data)['content'][0]['text'] == 'EXPECTED_ANSWER'
                        except urllib.error.HTTPError as e:
                            raise AssertionError(e.read().decode()) from e
                        count += 1
                        print('PASS full HTTP:',model,'stream=',stream)
                    bad = json.dumps(dict(model='mock,bad-json',max_tokens=32,stream=False,messages=[dict(role='user',content='local test')])).encode()
                    req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/messages',data=bad,
                                                 headers={'Content-Type':'application/json','x-api-key':'test-only'})
                    try:
                        with opener.open(req,timeout=8) as r:
                            raise AssertionError('invalid JSON unexpectedly succeeded: '+r.read().decode())
                    except urllib.error.HTTPError as e:
                        assert e.code >= 400
                        print('PASS full HTTP: invalid JSON rejected, status=',e.code)
                        count += 1
                    def post(endpoint, payload):
                        req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/messages'+endpoint,
                                                     data=json.dumps(payload).encode(),
                                                     headers={'Content-Type':'application/json','x-api-key':'test-only'})
                        with opener.open(req,timeout=8) as r:
                            assert r.status == 200
                            return json.loads(r.read())

                    image = dict(type='image',source=dict(type='base64',media_type='image/png',data='ABCD'*150000))
                    def tool_call(id):
                        return dict(type='tool_use',id=id,name='Read',input=dict(file_path='/test/'+id+'.png'))
                    def tool_result(id, content):
                        return dict(type='tool_result',tool_use_id=id,content=content)
                    tools = [dict(name='Read',description='Read a file',input_schema=dict(type='object',properties={}))]
                    messages = [dict(role='assistant',content=[tool_call('a'),tool_call('b')]),
                                dict(role='user',content=[tool_result('a',[dict(type='text',text='caption'),image])]),
                                dict(role='user',content=[tool_result('b','text result'),dict(type='text',text='describe it')])]
                    for stream in [False,True]:
                        payload = dict(model='mock,json',max_tokens=32,stream=stream,tools=tools,messages=messages)
                        req = urllib.request.Request(f'http://127.0.0.1:{port}/v1/messages',data=json.dumps(payload).encode(),
                                                     headers={'Content-Type':'application/json','x-api-key':'test-only'})
                        with opener.open(req,timeout=8) as r:
                            assert 'EXPECTED_ANSWER' in r.read().decode()
                        sent = Upstream.requests[-1]['messages']
                        assert [m['role'] for m in sent] == ['assistant','tool','tool','user','user']
                        assert [m['tool_call_id'] for m in sent[1:3]] == ['a','b']
                        assert len(sent[1]['content']) < 250
                        assert image['source']['data'] not in sent[1]['content']
                        assert sent[3]['content'][1]['image_url']['url'] == 'data:image/png;base64,'+image['source']['data']
                        count += 1
                        print('PASS full HTTP: tool images remain image_url, stream=',stream)

                    before = len(Upstream.requests)
                    payload = dict(model='mock,json',messages=messages,tools=tools)
                    large_count = post('/count_tokens',payload)['input_tokens']
                    image['source']['data'] = 'AA=='
                    small_count = post('/count_tokens',payload)['input_tokens']
                    assert large_count == small_count
                    assert 4096 <= large_count < 10000, large_count
                    assert len(Upstream.requests) == before, 'count_tokens must stay local'
                    count += 1
                    print('PASS full HTTP: count_tokens ignores base64 length, tokens=',large_count)

                    payload = dict(model='mock,json',max_tokens=32,stream=False,
                                   messages=[dict(role='user',content=[image])])
                    post('',payload)
                    sent = Upstream.requests[-1]['messages']
                    assert sent[0]['role'] == 'user'
                    assert sent[0]['content'][0]['image_url']['url'] == 'data:image/png;base64,AA=='
                    count += 1
                    print('PASS full HTTP: direct image upload is preserved')
                    print('Full HTTP tests passed:',count)
                finally:
                    p.terminate()
                    try:
                        p.wait(timeout=4)
                    except subprocess.TimeoutExpired:
                        p.kill()
                        p.wait()
    finally:
        upstream.shutdown()
        upstream.server_close()


if __name__ == '__main__':
    main()
