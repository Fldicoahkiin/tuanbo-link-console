from pathlib import Path
import subprocess
import sys
import threading
import unittest

from owner_watch import OwnerWatch


class OwnerWatchTest(unittest.TestCase):
    def test_invalid_pipe_stops_and_reports_error(self):
        stopped = threading.Event()
        owner = OwnerWatch(-1,stopped)
        self.assertTrue(stopped.wait(2))
        with self.assertRaisesRegex(RuntimeError,'Owner pipe read failed'):
            owner.check()

    def test_eof_stops_after_bounded_discard(self):
        script = '''import sys,threading
from owner_watch import OwnerWatch
event=threading.Event()
owner=OwnerWatch(sys.stdin.fileno(),event)
assert event.wait(5), 'EOF was not observed'
owner.check()
'''
        result = subprocess.run([sys.executable,'-c',script],cwd=Path(__file__).parent,
            input=b'x'*16384,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8)
        self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace'))

    def test_failure_exits_while_owner_pipe_remains_open(self):
        script = '''import sys,threading,time
from owner_watch import OwnerWatch
OwnerWatch(sys.stdin.fileno(),threading.Event())
time.sleep(.1)
raise RuntimeError('inference failure fixture')
'''
        child = subprocess.Popen([sys.executable,'-X','faulthandler','-c',script],cwd=Path(__file__).parent,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            code = child.wait(timeout=5)
            error = child.stderr.read().decode(errors='replace')
            self.assertEqual(code,1,error)
            self.assertIn('inference failure fixture',error)
            self.assertNotIn('_enter_buffered_busy',error)
            self.assertNotIn('Fatal Python error',error)
        finally:
            child.stdin.close()
            child.wait(timeout=5)
            child.stdout.close()
            child.stderr.close()


if __name__ == '__main__':
    unittest.main()
