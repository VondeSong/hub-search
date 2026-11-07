"""Do not equate same classifier text with identical cross-round native context."""
import json
from connection_support import PREVIOUS,read,save

if __name__=='__main__':
    ident=read('development-contract.json')['slowPriorIds'][0]
    prior=next(r for r in json.loads((PREVIOUS/'evaluation.json').read_text(encoding='utf-8'))['results'] if r['id']==ident)
    current=[r for r in read('development-audit.json')['results'] if r['id']==ident]
    assert all(r['promptSha256']==prior['modelReceipt']['inputSha256'] for r in current)
    equivalence=read('mechanism.json')['sourceEquivalence']
    assert all(len(set(r['inputTokens']))==1 and r['sameInputHash'] for r in equivalence)
    save('cross-round-context-audit.json',{'id':ident,'classifierInputHashEqual':True,
        'priorNativeInputTokens':prior['modelReceipt']['usage']['inputTokens'],
        'currentNativeInputTokens':[r['receipt']['usage']['inputTokens'] for r in current],
        'priorCachedInputTokens':prior['modelReceipt']['usage']['cachedInputTokens'],
        'currentCachedInputTokens':[r['receipt']['usage']['cachedInputTokens'] for r in current],
        'withinCurrentPairedCases':12,'allWithinPairInputTokenCountsEqual':True,
        'contextChange':'Current child Codex home is empty and wholly isolated, whereas previous app-server used existing user home with experiment-owned SQLite state. Native scaffolding context is therefore not identical across rounds.',
        'conclusion':'Shorter repeat of the old 26s classifier input cannot identify a connection optimization or prove its tail fixed. Native internal complete prompt was not exported, so the exact source of the 2070-token difference is not asserted.',
        'modelCalls':0})
    print(json.dumps({'priorInput':prior['modelReceipt']['usage']['inputTokens'],
                      'currentInput':[r['receipt']['usage']['inputTokens'] for r in current],
                      'pairedCasesWithEqualInputTokens':len(equivalence)}))
