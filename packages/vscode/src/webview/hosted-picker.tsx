/** Hosted AI: one list of models that run on this computer (tagged Local) or on a ClikDeploy GPU, searchable by name
 * and by where ("local", "cloud"). Choosing one shows what starting it takes -- the download, or the price per hour --
 * and only then starts it (hosted-models/). */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HostedList, HostedPlan, HostedRow } from '../../../../src/hosted-models/types';
import { HOSTED_TAGS } from '../../../../src/hosted-models/types';
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
      (answer) => { if (answer.consent === false) start(row); else setStep((now) => (now?.row === row ? { row, plan: answer } : now)); },
      (failure: Error) => setStep((now) => (now?.row === row ? { row, error: failure.message } : now)),
    );
  };

  const rows = useMemo((): ListRow[] => (list?.rows ?? []).map((row) => ({
    key: `${row.target}:${row.id}`,
    onSelect: () => plan(row),
    render: () => (
      <div class="row">
        <span class="row-check"><Icon name={row.target === 'this-computer' ? 'device-desktop' : 'cloud'} /></span>
        <span class="row-main">
          <span class="row-label">{row.label}<span class={`hosted-tag ${row.target}`}>{HOSTED_TAGS[row.target]}</span>{row.recommended ? <span class="hosted-tag recommended">recommended</span> : null}</span>
          {row.detail ? <span class="row-detail">{row.detail}</span> : null}
        </span>
      </div>
    ),
  })), [list]);

  if (step) {
    const { row, plan: shown, error, starting } = step;
    return (
      <Popover label="Start a hosted model" onClose={props.onClose} class="picker" id="hosted-plan">
        <div class="picker-head">
          <button type="button" class="icon-button tiny" aria-label="Back to the list" disabled={starting} onClick={() => setStep(undefined)}><Icon name="arrow-left" /></button>
          <span class="picker-title">{shown?.title ?? row.label}<span class={`hosted-tag ${row.target}`}>{HOSTED_TAGS[row.target]}</span></span>
        </div>
        <div class="hosted-plan">
          {!shown && !error ? <div class="muted"><Spinner /> {row.target === 'clikdeploy' ? 'Asking ClikDeploy for a GPU and a price…' : 'Checking this computer…'}</div> : null}
          {shown ? <ul class="hosted-lines">{shown.lines.filter(Boolean).map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
          {error ? <div class="picker-error">{error}</div> : null}
          <div class="hosted-actions">
            <button type="button" class="secondary" disabled={starting} onClick={() => setStep(undefined)}>Cancel</button>
            {shown ? <button type="button" disabled={starting} onClick={() => start(row)}>{starting ? 'Starting…' : shown.confirm}</button> : null}
          </div>
          {shown?.costly ? <div class="muted hosted-note">It bills by the hour while it runs and nothing once it is stopped.</div> : null}
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
