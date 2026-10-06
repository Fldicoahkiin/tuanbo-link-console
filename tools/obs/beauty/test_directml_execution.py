"""The GPU serialization guard must survive failures and diagnostic timing."""
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
import directml_execution
from directml_execution import run, capture_timings, SubmissionQueue, fifo_submissions


class DirectMLExecutionTests(unittest.TestCase):
    def test_explicit_fifo_scope_restores_previous_scheduler(self):
        previous = directml_execution._submission_lock
        with self.assertRaisesRegex(RuntimeError,'worker stopped'):
            with fifo_submissions():
                self.assertIsInstance(directml_execution._submission_lock, SubmissionQueue)
                raise RuntimeError('worker stopped')
        self.assertIs(directml_execution._submission_lock, previous)

    def test_fifo_waiters_cannot_be_overtaken(self):
        queue = SubmissionQueue()
        order = []
        def work(index):
            with queue:
                order.append(index)
        with ThreadPoolExecutor(max_workers=3) as pool:
            with queue:
                jobs = []
                for index in range(3):
                    jobs.append(pool.submit(work,index))
                    # Observe actual queued arrival, not a sleep or assumption
                    # about when the executor starts each thread.
                    with queue._condition:
                        self.assertTrue(queue._condition.wait_for(lambda:len(queue._pending)==index+2,2))
            for job in jobs:
                job.result(timeout=2)
        self.assertEqual(order,[0,1,2])
        with self.assertRaisesRegex(RuntimeError,'failed submission'):
            with queue:
                raise RuntimeError('failed submission')
        with queue:
            order.append(3)
        self.assertEqual(order,[0,1,2,3])

    def test_capture_is_scoped_and_cleared_after_failure(self):
        class Session:
            def run(self, outputs, inputs):
                return inputs
        with self.assertRaisesRegex(RuntimeError,'scope failure'):
            with capture_timings() as failed:
                run(Session(),[],{})
                raise RuntimeError('scope failure')
        with capture_timings() as current:
            run(Session(),[],{})
        run(Session(),[],{})
        self.assertEqual(len(failed),1)
        self.assertEqual(len(current),1)

    def test_sessions_remain_serial_with_timing(self):
        entered = threading.Event()
        release = threading.Event()
        second_started = threading.Event()
        second_entered = threading.Event()

        class First:
            def run(self, outputs, inputs):
                entered.set()
                if not release.wait(2):
                    raise TimeoutError('Test did not release first session')
                return inputs

        class Second:
            def run(self, outputs, inputs):
                second_entered.set()
                return inputs

        first_timing, second_timing = {}, {}
        def second_call():
            second_started.set()
            return run(Second(), [], {'second':1}, timing=second_timing)

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(run, First(), [], {'first':1}, timing=first_timing)
            try:
                self.assertTrue(entered.wait(2))
                second = pool.submit(second_call)
                self.assertTrue(second_started.wait(2))
                self.assertFalse(second_entered.wait(.03))
            finally:
                release.set()
            self.assertEqual(first.result(timeout=2), {'first':1})
            self.assertEqual(second.result(timeout=2), {'second':1})
        self.assertTrue(second_entered.is_set())
        for timing in (first_timing, second_timing):
            self.assertGreaterEqual(timing['waitMs'], 0)
            self.assertGreaterEqual(timing['executionMs'], 0)

    def test_failure_is_not_retried_and_releases_guard(self):
        class Failure:
            calls = 0
            def run(self, outputs, inputs):
                self.calls += 1
                raise RuntimeError('GPU failure')
        class Success:
            def run(self, outputs, inputs):
                return 42
        session, timing = Failure(), {}
        with self.assertRaisesRegex(RuntimeError, 'GPU failure'):
            run(session, [], {}, timing=timing)
        self.assertEqual(session.calls, 1)
        self.assertIn('executionMs', timing)
        self.assertEqual(run(Success(), [], {}), 42)


if __name__ == '__main__':
    unittest.main()
