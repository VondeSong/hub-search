"""Adversarial mechanical-boundary checks, separate from model quality."""
import copy
import unittest

from applicability_policy import validate_decisions


class Controls(unittest.TestCase):
    def setUp(self):
        self.memories = [{'id': 'm-a', 'project': 'p-a', 'status': 'confirmed', 'text': '流程需要明确确认。'}]
        self.tasks = [{'id': 'q-a', 'project': 'p-a', 'candidateIds': ['m-a']}]
        self.response = {'decisions': [{'id': 'q-a', 'outcome': 'supported', 'memoryId': 'm-a', 'quote': '需要明确确认', 'reasonCode': 'evidence_support'}]}

    def test_exact_source_is_admitted(self):
        self.assertEqual(validate_decisions(self.response, self.tasks, self.memories)[0]['ids'], ['m-a'])

    def test_invented_quote_is_rejected(self):
        self.response['decisions'][0]['quote'] = '已经确认完成'
        self.assertEqual(validate_decisions(self.response, self.tasks, self.memories)[0]['ids'], [])

    def test_foreign_candidate_cannot_be_borrowed(self):
        self.tasks[0]['candidateIds'] = []
        self.assertEqual(validate_decisions(self.response, self.tasks, self.memories)[0]['invalid'], 'candidate_membership')

    def test_matching_id_does_not_override_current_scope(self):
        self.memories[0]['project'] = 'p-b'
        self.assertEqual(validate_decisions(self.response, self.tasks, self.memories)[0]['invalid'], 'scope_or_state')

    def test_matching_id_does_not_override_confirmation(self):
        self.memories[0]['status'] = 'candidate'
        self.assertEqual(validate_decisions(self.response, self.tasks, self.memories)[0]['invalid'], 'scope_or_state')

    def test_duplicate_or_missing_task_cannot_hide_coverage(self):
        self.response['decisions'].append(copy.deepcopy(self.response['decisions'][0]))
        with self.assertRaises(ValueError):
            validate_decisions(self.response, self.tasks, self.memories)

    def test_abstention_cannot_carry_unchecked_body(self):
        self.response['decisions'][0]['outcome'] = 'abstain'
        row = validate_decisions(self.response, self.tasks, self.memories)[0]
        self.assertEqual(row['ids'], [])
        self.assertEqual(row['invalid'], 'invalid_abstention')


if __name__ == '__main__':
    unittest.main()
