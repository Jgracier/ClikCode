/** Hosted AI: one list of models, those that fit this computer first and then what ClikDeploy can run, searchable by name and by
 * where ("local", "cloud"). Choosing one asks where to run it only when there is a choice -- a model that fits this computer can
 * also run on ClikDeploy, each with what it takes -- and for a model that needs a GPU shows ClikDeploy's estimate (hosted-models/). */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HostedList, HostedPlan, HostedRow } from '../../../../src/hosted-models/types';
import { request } from './bus';
import { choose } from './picker';
import { Icon, KeyList, Popover, Spinner, useSlowWait, type ListRow } from './ui';

type PlanState = { row: HostedRow; plan?: HostedPlan; error?: string; starting?: boolean };

const UNAVAILABLE_WORDS: Readonly<Record<string, string>> = {
  clikdeploy: 'ClikDeploy GPUs need an internet connection and a Gateway sign-in',
  'this-computer': 'Models for this computer could not be listed',
};

export function HostedPicker(props: { onBack: () => void; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const [search, setSearch] = useState('');
  const [list, setList] = useState<HostedList>();
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<PlanState>();
  const input = useRef<HTMLInputElement>(null);
  const slow = useSlowWait(loading);

  useEffect(() => { input.current?.focus(); }, []);

  // What the search finds, a moment after the typing stops. The last answer wins.
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      request<HostedList>({ method: 'query', query: 'hosted', search }).then((answer) => {
        if (live) { setList(answer); setLoading(false); }
      }, (failure: Error) => { if (live) { setList({ rows: [], unavailable: [] }); setLoading(false); props.onError(failure.message); } });
    }, search ? 250 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [search]);

  // Models Hugging Face has are looked for behind the list (about a minute the first time): ask again until that is done,
  // so they appear without a keystroke.
  const refreshing = list?.refreshing === true;
  useEffect(() => {
    if (!refreshing) return undefined;
    let live = true;
    const timer = setInterval(() => {
      request<HostedList>({ method: 'query', query: 'hosted', search }).then((answer) => { if (live) setList(answer); }, () => undefined);
    }, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [refreshing, search]);

  const start = (row: HostedRow): void => {
    setStep((now) => (now ? { ...now, starting: true } : now));
    choose({ kind: 'hosted', row }).then(
      () => props.onClose(),
      (failure: Error) => setStep((now) => (now ? { row: now.row, plan: now.plan, error: failure.message } : now)),
    );
  };

  const plan = (row: HostedRow): void => {
    setStep({ row });
    request<HostedPlan>({ method: 'query', query: 'hosted-plan', row }).then(
      // Nothing to agree to (a model already on this computer): choosing the row was the decision, so no card.
      // With the same model on ClikDeploy as an alternative there is a real choice, so the card asks.
      (answer) => { if (answer.consent === false && !answer.alternative) start(row); else setStep((now) => (now?.row === row ? { row, plan: answer } : now)); },
      (failure: Error) => setStep((now) => (now?.row === row ? { row, error: failure.message } : now)),
    );
  };

  // Where it runs is the group a row is under, not a tag on every row.
  const rows = useMemo((): ListRow[] => (list?.rows ?? []).flatMap((row, index, all): ListRow[] => {
    const heading: ListRow[] = row.target !== all[index - 1]?.target
      ? [{ key: `h:${row.target}`, heading: true, render: () => <>{row.target === 'this-computer' ? 'Fits this computer' : 'On ClikDeploy'}</> }] : [];
    return [...heading, {
      key: `${row.target}:${row.id}`,
      onSelect: () => plan(row),
      render: () => (
        <div class="row">
          <span class="row-check"><Icon name={row.target === 'this-computer' ? 'device-desktop' : 'cloud'} /></span>
          <span class="row-main">
            <span class="row-label">{row.label}{row.recommended ? <span class="hosted-tag recommended">recommended</span> : null}</span>
            {row.detail ? <span class="row-detail">{row.detail}</span> : null}
          </span>
        </div>
      ),
    }];
  }), [list]);

  if (step) {
    const { row, plan: shown, error, starting } = step;
    return (
      <Popover label="Start a hosted model" onClose={props.onClose} class="picker" id="hosted-plan">
        <div class="picker-head">
          <button type="button" class="icon-button tiny" aria-label="Back to the list" disabled={starting} onClick={() => setStep(undefined)}><Icon name="arrow-left" /></button>
          <span class="picker-title">{shown?.alternative ? row.label : shown?.title ?? row.label}</span>
        </div>
        <div class="hosted-plan">
          {!shown && !error ? <div class="muted"><Spinner /> {row.target === 'clikdeploy' ? 'Asking ClikDeploy for a GPU and a price…' : 'Checking this computer…'}</div> : null}
          {shown && !shown.alternative ? <ul class="hosted-lines">{shown.lines.filter(Boolean).map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
          {error ? <div class="picker-error">{error}</div> : null}
          {shown?.alternative ? (
            // Here, or there: each says what it takes, and choosing one is the consent.
            <div class="hosted-where">
              <button type="button" disabled={starting} onClick={() => start(row)}>
                <span class="where-label">Run on this computer</span><span class="where-detail">{shown.summary}</span>
              </button>
              <button type="button" class="secondary" disabled={starting} onClick={() => start(shown.alternative!.row)}>
                <span class="where-label">Run on ClikDeploy</span><span class="where-detail">{shown.alternative.plan.summary}</span>
              </button>
              <div class="muted hosted-note">{starting ? 'Starting…' : 'A GPU on ClikDeploy bills by the hour while it runs and nothing once it is stopped.'}</div>
            </div>
          ) : (
            <div class="hosted-actions">
              <button type="button" class="secondary" disabled={starting} onClick={() => setStep(undefined)}>Cancel</button>
              {shown ? <button type="button" disabled={starting} onClick={() => start(row)}>{starting ? 'Starting…' : shown.confirm}</button> : null}
            </div>
          )}
          {shown?.costly && !shown.alternative ? <div class="muted hosted-note">It bills by the hour while it runs and nothing once it is stopped.</div> : null}
        </div>
      </Popover>
    );
  }

  return (
    <Popover label="Hosted AI" onClose={props.onClose} class="picker" id="hosted-picker">
      <div class="picker-head">
        <button type="button" class="icon-button tiny" aria-label="Back to the models" onClick={props.onBack}><Icon name="arrow-left" /></button>
        <span class="picker-title">Hosted AI <span class="muted">· this computer or a ClikDeploy GPU</span></span>
        {loading && slow ? <span role="img" aria-label="Loading models"><Spinner /></span> : null}
      </div>
      <div class="search">
        <Icon name="search" />
        <input ref={input} type="text" value={search} placeholder="Search models · add “local” or “cloud” to choose where"
          aria-label="Search hosted models" aria-controls="hosted-list" onInput={(event) => setSearch((event.target as HTMLInputElement).value)} />
      </div>
      {refreshing ? <div class="picker-note muted"><Spinner /> Looking for more models…</div> : null}
      {(list?.unavailable ?? []).map((item) => <div class="picker-note muted" key={item.target} title={item.message}><Icon name="info" /> {UNAVAILABLE_WORDS[item.target] ?? item.message}</div>)}
      <KeyList id="hosted-list" rows={rows} label="Hosted models" inputRef={input} onEscape={props.onBack}
        emptyText={loading ? (slow ? 'Finding models…' : undefined) : 'No models match.'} />
      <div class="picker-foot muted">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Enter</kbd> choose</span><span><kbd>Esc</kbd> back</span>
      </div>
    </Popover>
  );
}
