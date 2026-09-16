"""Test failure handling without cloud credentials or API calls."""
import datetime
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

storage = types.ModuleType('google.cloud.storage')
storage.Client = Mock()
auth = types.ModuleType('google.auth')
auth.default = Mock(return_value=(object(), None))
requests = types.ModuleType('google.auth.transport.requests')
requests.AuthorizedSession = Mock()
modules = {
    'google': types.ModuleType('google'),
    'google.auth': auth,
    'google.auth.transport': types.ModuleType('google.auth.transport'),
    'google.auth.transport.requests': requests,
    'google.cloud': types.ModuleType('google.cloud'),
    'google.cloud.storage': storage,
}
modules['google'].auth = auth
modules['google'].cloud = modules['google.cloud']
modules['google.cloud'].storage = storage
with patch.dict(sys.modules, modules), patch.dict(os.environ, {'GCP_PROJECT_ID':'test', 'SNAPSHOT_BUCKET':'test'}):
    spec = importlib.util.spec_from_file_location('job', Path(__file__).resolve().parents[1]/'ops/cloud-run/update.py')
    job = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(job)

class UpdateTests(unittest.TestCase):
    def test_failed_revision_is_not_treated_as_ready(self):
        responses = [{'name':'operations/test'}, {'done':True, 'error':{'code':7,'message':'denied'}}]
        with patch.object(job, 'api', side_effect=responses), self.assertRaisesRegex(RuntimeError, 'denied'):
            job.replace_template('geo-osrm-car', {'containers':[]})

    def test_revision_waits_for_completion(self):
        responses = [{'name':'operations/test'}, {'done':False}, {'done':True}]
        with patch.object(job, 'api', side_effect=responses) as api, patch.object(job.time, 'sleep'):
            job.replace_template('geo-osrm-car', {'containers':[]})
            self.assertEqual(api.call_count, 3)
            self.assertEqual(api.call_args_list[0].args[0], 'PATCH')

    def test_cleanup_preserves_current_previous_and_recent_releases(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        def blob(release, days):
            b = Mock()
            b.name = 'releases/'+release+'/places.sqlite'
            b.updated = now - datetime.timedelta(days=days)
            b.generation = 17
            return b
        live, rollback, recent, expired = [blob(*args) for args in [('current',20),('previous',30),('recent',2),('expired',9)]]
        with patch.object(job, 'bucket') as bucket:
            bucket.list_blobs.return_value = [live, rollback, recent, expired]
            job.prune_releases({'releases/current','releases/previous'})
        for b in [live, rollback, recent]:
            b.delete.assert_not_called()
        expired.delete.assert_called_once_with(if_generation_match=17)

if __name__ == '__main__':
    unittest.main()
