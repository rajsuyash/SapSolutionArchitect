"use client";

import { useId } from "react";
import type { DiscoveryInput } from "../lib/discovery";
import { CATALOG_RELEASES } from "../lib/sap-releases";
import styles from "./discovery.module.css";

type Source = DiscoveryInput["sources"][number];
type Evidence = DiscoveryInput["requirements"][number]["evidence"];
type Collection = "sources" | "asIsSteps" | "requirements" | "conflicts" | "openQuestions";
const newId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const emptySource = (id = "SRC-1"): Source => ({ id, title: "", revision: "", locator: "", text: "" });
export const emptyStep = (id = "AS-1", sourceId = "SRC-1", sequence = 1): DiscoveryInput["asIsSteps"][number] => ({
  id, sequence, name: "", actor: "", system: "", trigger: "", description: "", inputs: [], outputs: [],
  controls: [], exceptions: [], evidence: { sourceId, quote: "" },
});
export const emptyRequirement = (id = "R-1", sourceId = "SRC-1", asIsStepId = "AS-1"): DiscoveryInput["requirements"][number] => ({
  id, asIsStepId, kind: "TO_BE_REQUIREMENT", statement: "", critical: true, evidence: { sourceId, quote: "" },
});
export const emptyDiscovery = (): DiscoveryInput => ({ schemaVersion: 1, variantName: "", targetRelease: null,
  sources: [emptySource()], asIsSteps: [emptyStep()], requirements: [emptyRequirement()], conflicts: [], openQuestions: [] });

function Field({ name, value, change, multiline = false, required = true, limit = 8000 }:
  { name: string; value: string; change: (value: string) => void; multiline?: boolean; required?: boolean; limit?: number }) {
  const fieldId = useId();
  return <div><label htmlFor={fieldId}>{name}</label>
    {multiline ? <textarea id={fieldId} value={value} onChange={event => change(event.target.value)} required={required} maxLength={limit} rows={3} />
      : <input id={fieldId} value={value} onChange={event => change(event.target.value)} required={required} maxLength={limit} pattern={required ? ".*\\S.*" : undefined} />}
  </div>;
}
/** Offers only releases that have a verified SAP catalog; a previously saved free-text value stays selectable. */
export function ReleaseSelect({ id, value, change }: { id: string; value: string | null; change: (value: string | null) => void }) {
  const known = (CATALOG_RELEASES as readonly string[]).includes(value ?? "");
  return <div><label htmlFor={id}>Target SAP release</label>
    <select id={id} value={value ?? ""} onChange={event => change(event.target.value || null)}>
      <option value="">Not decided</option>
      {CATALOG_RELEASES.map(release => <option key={release} value={release}>{release} (verified SAP reference catalog)</option>)}
      {value && !known && <option value={value}>{value} (no verified SAP reference catalog)</option>}
    </select></div>;
}
function EvidenceFields({ name, value, sources, change }:
  { name: string; value: Evidence; sources: Source[]; change: (value: Evidence) => void }) {
  const sourceFieldId = useId();
  return <div className={styles.evidence}>
    <label htmlFor={sourceFieldId}>{name} source</label><select id={sourceFieldId} value={value.sourceId} required onChange={event => change({ ...value, sourceId: event.target.value })}>
      <option value="" disabled>Choose a source</option>
      {sources.map((source, i) => <option key={source.id} value={source.id}>{source.title || `Source ${i + 1}`} · {source.locator || "Location needed"}</option>)}
    </select>
    <Field name={`${name} exact quote`} value={value.quote} multiline change={quote => change({ ...value, quote })} />
    <a href={`#source-${value.sourceId}`}>View source for {name.toLowerCase()}</a>
  </div>;
}

export function DiscoveryFields({ value, change }: { value: DiscoveryInput; change: (input: DiscoveryInput) => void }) {
  function patch<K extends Collection>(key: K, index: number, update: Partial<DiscoveryInput[K][number]>) {
    change({ ...value, [key]: value[key].map((item, i) => i === index ? { ...item, ...update } : item) });
  }
  function remove(key: Collection, index: number) {
    const rows = value[key].filter((_, i) => i !== index);
    change({ ...value, [key]: key === "asIsSteps" ? rows.map((item, i) => ({ ...item, sequence: i + 1 })) : rows });
  }
  return <>
    <div className={styles.grid}>
      <Field name="Process variant name" value={value.variantName} limit={200} change={variantName => change({ ...value, variantName })} />
      <ReleaseSelect id="discovery-release" value={value.targetRelease} change={targetRelease => change({ ...value, targetRelease })} />
    </div>
    <p className={styles.help}>Choose Not decided if the release is unknown. Source notes are user-provided evidence and still need business review.</p>
    <section aria-labelledby="discovery-sources"><h2 id="discovery-sources">1. Source notes</h2>
      <p>Paste the original workshop notes or document excerpts. Record the document revision and a sheet/cell, page or section location.</p>
      {value.sources.map((source, i) => {
        const linked = [...value.asIsSteps, ...value.requirements].some(item => item.evidence.sourceId === source.id) ||
          value.conflicts.some(item => item.sourceIds.includes(source.id));
        return <div className={styles.card} key={source.id} id={`source-${source.id}`}>
          <h3>Source {i + 1}</h3>
          <div className={styles.grid}>
            {(["title", "revision", "locator"] as const).map(key => <Field key={key} name={`Source ${i + 1} ${key === "locator" ? "location" : key}`}
              value={source[key]} limit={200} change={text => patch("sources", i, { [key]: text })} />)}
          </div>
          <Field name={`Source ${i + 1} original text`} value={source.text} limit={40000} multiline change={text => patch("sources", i, { text })} />
          <button type="button" disabled={value.sources.length === 1 || linked} onClick={() => remove("sources", i)}>Remove source {i + 1}</button>
          {linked && <p className={styles.help}>Referenced below. Reassign those references before removing this source.</p>}
        </div>;
      })}
      <button type="button" disabled={value.sources.length >= 200} onClick={() => change({ ...value, sources: [...value.sources, emptySource(newId("SRC"))] })}>Add source</button>
    </section>
    <section aria-labelledby="discovery-current"><h2 id="discovery-current">2. Current process</h2>
      <p>Describe what happens today. Keep requested changes in the requirements section.</p>
      {value.asIsSteps.map((step, i) => <div className={styles.card} key={step.id}>
        <h3>Current step {i + 1}</h3>
        <div className={styles.grid}>{(["name", "actor", "system"] as const).map(key => <Field key={key} name={`Current step ${i + 1} ${key}`}
          value={step[key]} limit={200} change={text => patch("asIsSteps", i, { [key]: text })} />)}</div>
        {(["trigger", "description"] as const).map(key => <Field key={key} name={`Current step ${i + 1} ${key}`}
          value={step[key]} multiline change={text => patch("asIsSteps", i, { [key]: text })} />)}
        <div className={styles.grid}>{(["inputs", "outputs", "controls", "exceptions"] as const).map(key =>
          <Field key={key} name={`Current step ${i + 1} ${key} (one per line, optional)`} value={step[key].join("\n")} multiline required={false}
            change={text => patch("asIsSteps", i, { [key]: text.split("\n") })} />)}</div>
        <EvidenceFields name={`Current step ${i + 1}`} value={step.evidence} sources={value.sources} change={evidence => patch("asIsSteps", i, { evidence })} />
        <button type="button" disabled={value.asIsSteps.length === 1 || value.requirements.some(item => item.asIsStepId === step.id)}
          onClick={() => remove("asIsSteps", i)}>Remove current step {i + 1}</button>
      </div>)}
      <button type="button" disabled={value.asIsSteps.length >= 200} onClick={() => change({ ...value,
        asIsSteps: [...value.asIsSteps, emptyStep(newId("AS"), value.sources[0]!.id, value.asIsSteps.length + 1)] })}>Add current step</button>
    </section>
    <section aria-labelledby="discovery-requirements"><h2 id="discovery-requirements">3. Requirements and pain points</h2>
      <p>Capture each business need separately and link it to the current step it affects.</p>
      {value.requirements.map((requirement, i) => <div className={styles.card} key={requirement.id}>
        <h3>Requirement {i + 1}</h3>
        <div className={styles.grid}>
          <div><label htmlFor={`${requirement.id}-kind`}>Requirement {i + 1} type</label><select id={`${requirement.id}-kind`} value={requirement.kind} onChange={event => patch("requirements", i,
            { kind: event.target.value as typeof requirement.kind })}>
            <option value="TO_BE_REQUIREMENT">Future requirement</option><option value="PAIN_POINT">Current pain point</option><option value="CONTROL">Business control</option>
          </select></div>
          <div><label htmlFor={`${requirement.id}-step`}>Requirement {i + 1} current step</label><select id={`${requirement.id}-step`} value={requirement.asIsStepId} required onChange={event => patch("requirements", i, { asIsStepId: event.target.value })}>
            {value.asIsSteps.map((step, j) => <option key={step.id} value={step.id}>{j + 1}. {step.name || "Unnamed step"}</option>)}
          </select></div>
        </div>
        <Field name={`Requirement ${i + 1} statement`} value={requirement.statement} multiline change={statement => patch("requirements", i, { statement })} />
        <label className={styles.checkbox}><input type="checkbox" checked={requirement.critical}
          onChange={event => patch("requirements", i, { critical: event.target.checked })} />Requirement {i + 1} is critical</label>
        <EvidenceFields name={`Requirement ${i + 1}`} value={requirement.evidence} sources={value.sources} change={evidence => patch("requirements", i, { evidence })} />
        <button type="button" disabled={value.requirements.length === 1} onClick={() => remove("requirements", i)}>Remove requirement {i + 1}</button>
      </div>)}
      <button type="button" disabled={value.requirements.length >= 200} onClick={() => change({ ...value,
        requirements: [...value.requirements, emptyRequirement(newId("R"), value.sources[0]!.id, value.asIsSteps[0]!.id)] })}>Add requirement</button>
    </section>
    <section aria-labelledby="discovery-decisions"><h2 id="discovery-decisions">4. Conflicts and open questions</h2>
      <p>Record contradictory instructions or missing decisions so they remain visible during design.</p>
      {value.conflicts.map((conflict, i) => <div className={styles.card} key={conflict.id}>
        <Field name={`Conflict ${i + 1} question`} value={conflict.question} multiline change={question => patch("conflicts", i, { question })} />
        <label htmlFor={`${conflict.id}-sources`}>Conflict {i + 1} sources (select all that apply)</label><select id={`${conflict.id}-sources`} multiple required value={conflict.sourceIds}
          onChange={event => patch("conflicts", i, { sourceIds: Array.from(event.target.selectedOptions, option => option.value) })}>
          {value.sources.map((source, j) => <option key={source.id} value={source.id}>{source.title || `Source ${j + 1}`}</option>)}
        </select>
        <button type="button" onClick={() => remove("conflicts", i)}>Remove conflict {i + 1}</button>
      </div>)}
      <button type="button" disabled={value.conflicts.length >= 100} onClick={() => change({ ...value,
        conflicts: [...value.conflicts, { id: newId("CON"), question: "", sourceIds: [value.sources[0]!.id] }] })}>Add conflict</button>
      {value.openQuestions.map((question, i) => <div className={styles.card} key={question.id}>
        <Field name={`Open question ${i + 1}`} value={question.question} multiline change={text => patch("openQuestions", i, { question: text })} />
        <Field name={`Open question ${i + 1} owner`} value={question.owner} limit={200} change={owner => patch("openQuestions", i, { owner })} />
        <button type="button" onClick={() => remove("openQuestions", i)}>Remove open question {i + 1}</button>
      </div>)}
      <button type="button" disabled={value.openQuestions.length >= 100} onClick={() => change({ ...value,
        openQuestions: [...value.openQuestions, { id: newId("Q"), question: "", owner: "" }] })}>Add open question</button>
    </section>
  </>;
}

export function cleanDiscovery(input: DiscoveryInput): DiscoveryInput {
  return { ...input, asIsSteps: input.asIsSteps.map(step => ({ ...step,
    inputs: step.inputs.map(text => text.trim()).filter(Boolean), outputs: step.outputs.map(text => text.trim()).filter(Boolean),
    controls: step.controls.map(text => text.trim()).filter(Boolean), exceptions: step.exceptions.map(text => text.trim()).filter(Boolean),
  })) };
}

export function quoteIssue(input: DiscoveryInput): string | null {
  for (const [label, rows] of [["Current step", input.asIsSteps], ["Requirement", input.requirements]] as const) {
    for (const [i, row] of rows.entries()) {
      if (!row.evidence.quote.trim() || !input.sources.find(source => source.id === row.evidence.sourceId)?.text.includes(row.evidence.quote)) {
        return `${label} ${i + 1}: the exact quote must appear in its selected source.`;
      }
    }
  }
  return null;
}
