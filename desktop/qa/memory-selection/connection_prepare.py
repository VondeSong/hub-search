"""Scope and budget are fixed before model probes or benchmark question selection."""
from datetime import datetime,timezone
import json
from pathlib import Path

from connection_support import ROOT,WORK,HOME,PREVIOUS,save,digest
from passage_delivery import snapshot

if __name__=='__main__':
    WORK.mkdir(parents=True,exist_ok=False)
    HOME.mkdir()
    (WORK/'tmp').mkdir()
    production=snapshot()
    assert production==json.loads((PREVIOUS/'scope-contract.json').read_text(encoding='utf-8'))['production']
    save('scope-contract.json',{'createdAt':datetime.now(timezone.utc).isoformat(),
        'root':str(ROOT),'result':'Actual cross-question remote reuse inside isolation, investigate previous 26s tail, paired comparison then one new frozen holdout.',
        'model':'gpt-6.1-sol','effort':'xhigh','tier':'default',
        'allowed':['QA sources, owned runtime and evidence','short actual Codex calls','same-topic paired development','new synthetic frozen data','existing plan and QA README'],
        'forbidden':['production changes','backend adoption','later HBM batches','global config or existing user thread mutations','new packages/model downloads','private-note corpus','new paid tier','deleting old evidence'],
        'ownership':{'runtime':str(WORK),'codexHome':str(HOME),'artifacts':'artifacts/hbm-00-connection-20261018','sources':'qa/memory-selection/connection_*.py','plan':'docs/INSIGHTS_IMPLEMENTATION_PLAN.md'},
        'authentication':'Existing login access token supplied in memory via documented external-token RPC only after isolated home is confirmed. No auth file copy, command-line secret or credential persistence; detect secrets before delivery.',
        'budget':{'preflightTurnsMax':4,'pairedCases':12,'pairedRounds':2,'pairedTurnsMax':48,'diagnosticFollowupTurnsMax':8,
                  'formalQuestions':80,'formalExecutionsMax':1,'callTimeoutSeconds':120,'explicitRetries':0,'newLogicalBytesMax':180_000_000},
        'development':'Three slowest prior formal questions plus nine remaining opaque-id-sorted prior questions. Both modes on same process/home/cwd; AB/BA alternate and reverse on round two.',
        'selection':'Require exact development outcomes, no quote/protocol/state/scope/history leakage, and observed cross-question connection reuse. Choose reuse only if paired median saving >=10%, >=16/24 faster and candidate P95 <= baseline P95; otherwise keep current independent-thread persistent process.',
        'validation':{'positive':40,'negative':40,'candidateRecallAt5':.9,'selectedRecall':.9,'negativeFalseSelections':0,'selectedPrecision':.8,'invalidDecisions':0,
                      'methodBeforeNewFacts':True,'postFreezeTuning':False,'postFreezeLabelEdits':False},
        'tailHypotheses':['connection or prewarm timeout/retry','upstream queue/prefill/hidden inference before first output','stream gap after first output','host reader/observer stall'],
        'attributionLimit':'Client/OTel timelines can distinguish setup, prewarm and request/stream waits, but cannot manufacture pure network versus server queue versus hidden inference timing.',
        'production':production,'priorSummarySha256':digest(PREVIOUS/'summary.json'),
        'retention':'Keep all failed preparation, probes and data. Close owned processes before local delivery. No scheduled work.',
        'stop':'HBM-00 local evidence/report only, overall gate remains open, backend undecided.'})
    print(json.dumps({'productionFiles':len(production),'unchanged':True}))
