"""Post-run manual semantic review; NEVER relabels or changes frozen scores."""
import difflib
import hashlib
import json
from pathlib import Path
from parity_support import *

if __name__=='__main__':
    evaluation=read('evaluation.json');assert evaluation['status']=='completed'
    scored=read('scored-results.json')['hub-native-hybrid']
    cases={q['id']:q for q in read('validation.json')['cases']}
    rows={r['id']:r for r in evaluation['rows'] if r['backend']=='hub-native-hybrid'}
    notes=read('real-notes.json');targets=set(notes['targetIds'])
    changed=[]
    for source in notes['sources']:
        assert digest(source['snapshot'])==source['sha256']
        if digest(source['path'])!=source['sha256']:
            old=Path(source['snapshot']).read_text(encoding='utf-8-sig')
            new=Path(source['path']).read_text(encoding='utf-8-sig')
            lines=[line for line in difflib.unified_diff(old.splitlines(),new.splitlines(),n=0)
                   if line.startswith(('+','-')) and not line.startswith(('+++','---'))]
            changed.append({'id':source['id'],'path':source['path'],'oldSha256':source['sha256'],
                'currentSha256':digest(source['path']),'isPositiveTarget':source['id'] in targets,
                'differenceLines':len(lines),'observedChange':'MOC gained a source-navigation section.',
                'attribution':'Unattributed; experiment source operations were read-only. Do not claim all originals remained unchanged.'})
    save('source-concurrency-audit.json',{'at':now(),'changedOriginals':changed,'frozenSnapshotsUnchanged':56,
        'allPositiveTargetOriginalsUnchanged':not any(r['isPositiveTarget'] for r in changed),
        'corpusAndQuestionsUnchanged':True,'vaultWriteOperationsPerformedByExperiment':0})
    same_origin={
        'q-c6eaa8b4ada7c4f0':'Original classical quote directly supplies the analogy; frozen anchor used its modern-language gloss.',
        'q-ffb8a48309861dbc':'A different passage in the same note directly states that asserting fairness is not petty.',
        'q-589f27437b3d409a':'A different passage in the same source explains the same rich/poor substitution consequence.'}
    alternatives=[]
    for qid,reason in same_origin.items():
        r=rows[qid];assert r['checked']['ids'] and r['checked']['ids'][0] in cases[qid]['expected']
        alternatives.append({'id':qid,'reason':reason,'selectedQuote':r['checked']['decision']['quote'],
                             'formalScoreUnchanged':True})
    fp='q-4d8252c35a114c76';r=rows[fp]
    assert not cases[fp]['expected'] and r['checked']['ids']
    mid=r['checked']['ids'][0]
    selected=next(m['text'] for m in r['retrieval']['candidates'] if m['id']==mid)
    parent=next(n['content'] for n in notes['records'] if n['id']==mid)
    assert '连环漫画' in parent and '连环漫画' not in selected
    audit={'at':now(),'reviewer':'Primary agent, same model family, not independent annotation.',
        'frozenLabelsScorerAndScoresChanged':False,'extraModelCalls':0,
        'strictPassQuotesManuallyReviewed':13,'sameOriginSemanticAlternativesRejectedByLiteralAnchor':alternatives,
        'otherOriginAlternative':{'id':'q-092cc2f11c689d9f',
            'finding':'Another related reflection supplies equivalent advice; frozen gold IDs included only one note. Subject/record identity is not independently adjudicated; do not silently count as a pass.'},
        'negativeFalseSelection':{'id':fp,'quote':r['checked']['decision']['quote'],
            'finding':'Full source identifies a comic character and first member of one surname, not a documented first real patient. Injected passage drops comic identity; model accepted an enlarged subject/scope.',
            'sourceGenreInFullSource':True,'sourceGenreInInjectedPassage':False,'formalFalseSelectionRetained':True,
            'questionScopeCaveat':'First patient wording is not independently annotated; record the source/clinical-role ambiguity without relabeling or reducing the negative denominator.'},
        'scopeAndImplication':'Strict13/24 understates semantically valid same-source selections. Source-ID score remains16/24. Neither is a90% pass; no optimistic replacement of frozen gates.',
        'negativeDenominators':'Original100 and predeclared99 retained. One false selection remains in both. No zero-event upper bound applies.'}
    save('semantic-review.json',audit)
    native=json.loads((WORK/'formal-index/formal-native-output.json').read_text(encoding='utf-8'))
    positive_ids={q['id'] for q in cases.values() if q['expected']}
    lexical={r['id']:r for r in native['results']}
    code=ROOT/'src-tauri/src/search_index.rs'
    source=code.read_text(encoding='utf-8')
    assert 'parser.set_conjunction_by_default();' in source
    save('query-adapter-audit.json',{'at':now(),'hubQueryParserSource':str(code),'sourceSha256':digest(code),
        'productionDefault':'AND/conjunction at search_index.rs:828; multi-term queries do not receive single-term fuzzy expansion.',
        'frozenAdapter':'Whitespace join of sorted generic jieba terms, no explicit OR. Questions include generic words absent from the source passage.',
        'nonemptyLexicalQueries':sum(bool(r['ids']) for r in native['results']),'totalQueries':124,
        'positiveQueriesWithAnyLexicalResult':sum(bool(lexical[qid]['ids']) for qid in positive_ids),
        'diagnosis':'Common query adapter does not match the production search contract for natural questions; lexical leg failed to contribute to any positive. This limits full-hybrid/backend selection claims, not an embedding-quality diagnosis.',
        'counterfactualSearchesPerformed':0,'postRunQueryOrPolicyTuning':False,
        'remaining':'Generic query-contract repair belongs to a later preregistered experiment with a fresh holdout, not rerunning this set with OR.'})
    print(json.dumps({'originalSourcesChanged':len(changed),'frozenSourceCopiesUnchanged':56,
                      'sameOriginAlternativeQuotes':len(alternatives),'formalScoreChanged':False,
                      'lexicalPositiveNonempty':0,'negativeFalseSelectionsRetained':1}))
