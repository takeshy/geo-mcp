"""Weekly, bounded full rebuild. Existing immutable releases stay available on failure."""
import copy
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import uuid
import google.auth
from google.auth.transport.requests import AuthorizedSession
from google.cloud import storage

PROJECT = os.environ['GCP_PROJECT_ID']
REGION = os.environ.get('GCP_REGION', 'asia-northeast1')
BUCKET = os.environ['SNAPSHOT_BUCKET']
SERVICE = os.environ.get('MCP_SERVICE', 'geo-home-mcp')
API = f'https://run.googleapis.com/v2/projects/{PROJECT}/locations/{REGION}'
credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
session = AuthorizedSession(credentials)
bucket = storage.Client().bucket(BUCKET)

def run(*args):
    print(json.dumps({'command': args}), flush=True)
    subprocess.run(args, check=True)

def upload(path, object_name):
    bucket.blob(object_name).upload_from_filename(str(path), if_generation_match=0, timeout=600)

def api(method, path, **kwargs):
    r = session.request(method, path, timeout=90, **kwargs)
    r.raise_for_status()
    return r.json()

def replace_template(name, template):
    operation = api('PATCH', f'{API}/services/{name}?updateMask=template', json={'name':f'projects/{PROJECT}/locations/{REGION}/services/{name}', 'template':template})
    for _ in range(180):
        status = api('GET', 'https://run.googleapis.com/v2/' + operation['name'])
        if status.get('done'):
            if 'error' in status:
                raise RuntimeError(status['error'])
            return
        time.sleep(5)
    raise TimeoutError('Cloud Run revision did not become ready')

def prune_releases(protected):
    # Eight days accommodates in-flight requests and retains a full previous week.
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=8)
    groups = {}
    for blob in bucket.list_blobs(prefix='releases/'):
        parts = blob.name.split('/')
        if len(parts) < 3:
            continue
        prefix = '/'.join(parts[:2])
        groups.setdefault(prefix, []).append(blob)
    for prefix, blobs in groups.items():
        if prefix not in protected and all(b.updated and b.updated < cutoff for b in blobs):
            for blob in blobs:
                blob.delete(if_generation_match=blob.generation)
            print(json.dumps({'prunedRelease':prefix}), flush=True)

def main():
    # Scheduler retries cannot overlap or duplicate a successful ISO week's build.
    week = datetime.datetime.now(datetime.timezone.utc).strftime('%G-W%V')
    lock = bucket.blob(f'updates/{week}.json')
    lock.upload_from_string(json.dumps({'status':'running'}), if_generation_match=0)
    release = 'releases/' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    work = Path('/tmp/build')
    work.mkdir()
    source = work/'map.osm.pbf'
    previous = {}
    changed = []
    try:
        with urllib.request.urlopen(os.environ.get('OSM_PBF_URL', 'https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf'), timeout=120) as response, source.open('wb') as output:
            shutil.copyfileobj(response, output)
        run('python3', '/job/pbf_snapshot.py', str(source), str(work/'places.sqlite'))
        upload(work/'places.sqlite', release+'/places.sqlite')
        (work/'places.sqlite').unlink()
        for mode, profile in [('car','car'), ('foot','foot'), ('bike','bicycle')]:
            graph = work/mode
            graph.mkdir()
            os.link(source, graph/'map.osm.pbf')
            run('osrm-extract', '--threads', '8', '-p', '/opt/'+profile+'.lua', str(graph/'map.osm.pbf'))
            run('osrm-partition', '--threads', '8', str(graph/'map.osrm'))
            run('osrm-customize', '--threads', '8', str(graph/'map.osrm'))
            router = subprocess.Popen(['osrm-routed', '--algorithm','mld','--threads','1','--port','5000',str(graph/'map.osrm')])
            try:
                for attempt in range(120):
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:5000/route/v1/driving/139.697,35.531;139.767,35.681?overview=false', timeout=5) as response:
                            answer = json.load(response)
                        if answer.get('code') != 'Ok' or not answer.get('routes'):
                            raise RuntimeError('No smoke route for '+mode)
                        break
                    except OSError:
                        if router.poll() is not None:
                            raise RuntimeError('OSRM exited before readiness')
                        time.sleep(2)
                else:
                    raise TimeoutError('OSRM startup timed out')
            finally:
                router.terminate()
                router.wait(timeout=30)
            for path in sorted(graph.glob('map.osrm*')):
                upload(path, release+'/osrm/'+mode+'/'+path.name)
            shutil.rmtree(graph)
        # All artifacts and all three local route probes passed before deployment.
        for mode in ['car','foot','bike']:
            name = 'geo-osrm-'+mode
            old = api('GET', f'{API}/services/{name}')['template']
            old.pop('revision', None)
            previous[name] = old
            template = copy.deepcopy(old)
            args = template['containers'][0]['args']
            args[-1] = '/snapshots/'+release+'/osrm/'+mode+'/map.osrm'
            changed.append(name)
            replace_template(name, template)
        old = api('GET', f'{API}/services/{SERVICE}')['template']
        old.pop('revision', None)
        previous[SERVICE] = old
        template = copy.deepcopy(old)
        for env in template['containers'][0]['env']:
            if env['name'] == 'PLACES_SNAPSHOT_URI':
                env['value'] = 'gs://'+BUCKET+'/'+release+'/places.sqlite'
        changed.append(SERVICE)
        replace_template(SERVICE, template)
        previous_release = None
        for env in previous[SERVICE]['containers'][0]['env']:
            if env['name'] == 'PLACES_SNAPSHOT_URI':
                previous_release = env['value'].split('/'+BUCKET+'/')[1].rsplit('/',1)[0]
        bucket.blob('current.json').upload_from_string(json.dumps({'release':release, 'previousRelease':previous_release, 'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}), content_type='application/json')
        lock.upload_from_string(json.dumps({'status':'complete','release':release}))
        print(json.dumps({'published':release}), flush=True)
        try:
            protected = {release, previous_release}
            # Also retain all graph releases referenced before the update, even after a partial prior deployment.
            for name, template in previous.items():
                if name != SERVICE:
                    protected.add('/'.join(template['containers'][0]['args'][-1].split('/')[2:4]))
            prune_releases(protected)
        except Exception as error:
            print(json.dumps({'cleanupWarning':str(error)}), flush=True)
    except BaseException:
        for name in reversed(changed):
            try:
                replace_template(name, previous[name])
            except Exception as error:
                print(json.dumps({'rollbackFailed':name, 'error':str(error)}), flush=True)
        # Retain failed marker to prevent expensive automatic retries; operator can retry explicitly.
        lock.upload_from_string(json.dumps({'status':'failed','release':release}))
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)

if __name__ == '__main__':
    main()
