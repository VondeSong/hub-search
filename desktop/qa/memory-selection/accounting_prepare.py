"""Prospective gates, full-cost definitions and finite stopping conditions."""
from datetime import datetime,timezone
from accounting_support import ROOT,WORK,HOME,PREVIOUS,MODEL,EFFORT,save,digest
from passage_delivery import snapshot
import json

if __name__=='__main__':
    WORK.mkdir(parents=True,exist_ok=False); HOME.mkdir(); (WORK/'tmp').mkdir(); (WORK/'shared-cwd').mkdir()
    production=snapshot()
    old=json.loads((PREVIOUS/'scope-contract.json').read_text(encoding='utf-8'))
    assert production==old['production']
    save('scope-contract.json',{'createdAt':datetime.now(timezone.utc).isoformat(),
        'result':'Diagnose public admission errors; test independent-question connection reuse with complete prewarm accounting; close latency optimization after this round.',
        'model':MODEL,'effort':EFFORT,'tier':'default','production':production,
        'allowed':['New accounting QA sources and owned runtime/evidence','Read-only 10-note OS sample with source hashes','Actual bounded native Codex calls','Official public admission diagnostics without inference when grant missing','Existing implementation plan and QA README','Read-only backend remaining-gate audit'],
        'forbidden':['Production changes','Backend adoption','Later HBM batches','Global config or existing user-thread mutations','Credential copies or secrets in diagnostics','Unrequested new OAuth client consent or paid-key fallback','New packages/models','Private endpoint custom clients','Changing frozen policy or holdout labels'],
        'ownership':{'runtime':str(WORK),'home':str(HOME),'sourcePrefix':'qa/memory-selection/accounting_*','plan':'docs/INSIGHTS_IMPLEMENTATION_PLAN.md','noteSnapshots':'Owned experiment only; OS source files stay unchanged'},
        'budget':{'preflightTurnsMax':8,'pairedTurnsMax':48,'formalTurnsMax':140,'formalExecutionsMax':1,
                  'explicitRetries':0,'turnTimeoutSeconds':120,'drainTimeoutSeconds':20,'newLogicalBytesMax':240_000_000},
        'hypotheses':['Existing Codex grant lacks public direct scope or audience','Public route or regional policy rejects admission','Native HTTP pooling can reuse independent-question transport','Reset mode only hides reconnect/prewarm in think time'],
        'development':{'N':4,'rounds':2,'cadencesSeconds':[0,5],
            'cases':'Three slowest old latency-holdout questions plus lowest opaque-id negative among remaining; same canonical classifier inputs.',
            'modes':['persistent-ws','reset-ws','persistent-http if supported and observed'],
            'schedule':'Each mode receives a whole N-question batch in its own isolated process; rotate batch order by cadence and reverse in round two. No cross-mode background prewarm.',
            'scope':'Same shared thread cwd, account, model, effort, schema and source bytes; native metadata differences must be disclosed.'},
        'accounting':{'requestLedger':'Every observed HTTP request, websocket connect, websocket send and response completion gets its own event timestamp. Classify control, prewarm, question and final unused prewarm. Never count connect+send+completion as three inference requests.',
            'tokens':'Input, cached input, output, reasoning and total per completed response, including prewarm and unused final prewarm. Missing usage is unknown, not zero; complete usage is a qualification gate.',
            'wallClock':'Batch starts before child process initialization and ends after all automatic prewarm has settled and owned process/collector shutdown completes.',
            'cadence':'Record actual scheduled gaps separately. Gaps hide prewarm from user waiting, but requests and token usage still count. Report inclusive batch wall time, active wall time minus actual user gaps, per-question latency and drain time.',
            'costProxy':'Total processed input+output tokens, cached input separately; not an invoice. No dollar-cost claim without authoritative billing.',
            'eventClock':'Use native event.timestamp, never collector delivery time; missing/invalid event times fail qualification.'},
        'selection':{'mandatory':['Exact development outcomes and canonical quote/scope/history checks','Observed actual independent-question remote connection reuse','Complete per-request/prewarm/unused-prewarm usage ledger with native turn cross-check','Both continuous and spaced cadence must qualify'],
            'numeric':'For each cadence, median paired whole-batch active wall-time saving >=10% AND median paired all-response total-token saving >=10%, with per-question P95 no worse than baseline. No alternative weighting or outlier removal after outcomes.',
            'unavailable':'If no eligible candidate, retain baseline and state reuse not achieved. Do not loop optimizations.'},
        'holdout':{'positive':40,'negative':100,'realNoteQuestionsTarget':20,'newSyntheticPositiveQuestions':20,
            'qualityGates':{'candidateRecallAt5':.9,'selectedRecall':.9,'negativeFalseSelections':0,'selectedPrecision':.8,'invalidDecisions':0},
            'negativeUpperBound':'If zero false selections in 100 negatives, one-sided 95% binomial upper bound = 1-0.05**(1/100) = 2.95%; correlated same-author cases weaken generalization.',
            'difficulty':'Keep prior failed-type regressions separate; new holdout includes natural long-note tails, weak lexical wording, competing versions/conditions, quotation-as-instruction, absence vs negation, partial numbers and cross-project states. No rank-aware question edits.',
            'authorship':'Primary agent authors and audits; Codex GPT-6.1 Sol xhigh judges. Same model family, not independent labels.',
            'freeze':'Transport/policy/scorer before new note selection/facts/questions; labels and all inputs before first retrieval; one execution only.'},
        'stop':'After bounded admission/protocol probes, one paired comparison and one new frozen quality run, close the latency optimization track regardless of outcome. Switch the existing plan to remaining backend gates; do not begin another latency tuning round.',
        'priorSummarySha256':digest(PREVIOUS/'summary.json')})
    print(json.dumps({'contractRegistered':True,'productionFiles':len(production),'formalMax':140,'latencyTrackClosesAfterRound':True}))
