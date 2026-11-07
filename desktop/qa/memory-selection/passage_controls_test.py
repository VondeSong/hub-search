"""Source coverage and mechanical controls; no online model in this suite."""
import unittest

from passage_index import split_body,tokenizer
from applicability_policy import validate_decisions


class PassageControls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tok=tokenizer()

    def test_long_chinese_tail_is_preserved(self):
        text='交接背景需要查阅原始资料。'*80+'\n\n本轮确认输出横版16:9。'
        pieces=split_body(text,self.tok)
        self.assertTrue(any('横版16:9' in p['text'] for p in pieces))
        self.assertTrue(all(p['text']==text[p['start']:p['end']] for p in pieces))
        self.assertTrue(all(len(self.tok.encode(p['text'],add_special_tokens=False).ids)<=256 for p in pieces))

    def test_one_long_paragraph_has_token_overlap(self):
        text='记录没有被确认时不能执行分享。'*90
        pieces=split_body(text,self.tok)
        self.assertGreater(len(pieces),2)
        self.assertEqual(pieces[0]['start'],0)
        self.assertEqual(pieces[-1]['end'],len(text))
        self.assertTrue(all(a['end']>b['start'] for a,b in zip(pieces,pieces[1:])))

    def test_mixed_ascii_unicode_offsets_are_exact(self):
        text='A-17与A17不同。\n\nPDF 16:9；SVG另存。😀\n\n未登记实际交付时间。'
        pieces=split_body(text,self.tok)
        self.assertEqual(len(pieces),3)
        self.assertTrue(all(text[p['start']:p['end']]==p['text'] for p in pieces))

    def test_full_body_quote_cannot_be_fabricated(self):
        task={'id':'q','project':'p','candidateIds':['m']}
        memory={'id':'m','project':'p','status':'confirmed','text':'只登记了预算上限。'}
        response={'decisions':[{'id':'q','outcome':'supported','memoryId':'m','quote':'已经付款','reasonCode':'evidence_support'}]}
        self.assertEqual(validate_decisions(response,[task],[memory])[0]['invalid'],'quote_mismatch')


if __name__=='__main__':
    unittest.main()
