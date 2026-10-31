import type { ReactNode } from "react";
import { TEST_LABEL, testKindLabel, type ComparisonRow, type ImplementationView, type Register, type ReportModel, type StepView } from "../lib/consultant-report";
import { PrintButton } from "./report-print-button";
import styles from "./consultant-report.module.css";

const List = ({ items }: { items: string[] }) => items.length ? <ul className={styles.tight}>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className={styles.muted}>None</p>;
const Table = ({ label, children }: { label: string; children: ReactNode }) =>
  <div className={styles.tableWrap} role="region" aria-label={`${label} table`} tabIndex={0}><table>{children}</table></div>;

function Implementation({ implementation }: { implementation: ImplementationView }) {
  return <>
    <p><strong>{implementation.kindLabel}</strong></p><p>{implementation.detail}</p>
    {implementation.refs.map(ref => <p key={ref.id} className={styles.ref}>
      {ref.capability} <code className={styles.code}>{ref.id}</code>
      {ref.found && <> · {ref.fit}{ref.objects.length > 0 && <> · SAP objects: {ref.objects.join(", ")}</>}</>}
      {ref.urls.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">{" "}Official SAP evidence{ref.urls.length > 1 ? ` ${index + 1}` : ""}</a>)}
    </p>)}
  </>;
}

function ToBeCell({ view }: { view: StepView }) {
  const { step } = view;
  return <div className={styles.cellStep}>
    <p><a href={`#${view.anchor}`}><strong>{view.heading}</strong></a></p>
    <p>{step.actor} · starts when: {step.trigger}</p>
    <p className={styles.muted}>In: {step.inputDocuments.join(", ")}. Out: {step.outputDocuments.join(", ")}.</p>
    <List items={step.businessRules.map(rule => `${rule.condition} → ${rule.response}`)} />
    <p className={styles.muted}>Exceptions: {step.exceptions.length ? step.exceptions.map(item => `${item.condition} → ${item.response}`).join("; ") : step.exceptionsNotApplicableReason}</p>
  </div>;
}

function ComparisonTable({ rows }: { rows: ComparisonRow[] }) {
  return <Table label="As-Is versus To-Be comparison"><thead><tr>
    <th scope="col">Current process (As-Is)</th><th scope="col">Problems and requirements</th>
    <th scope="col">Proposed To-Be steps</th><th scope="col">SAP realization</th><th scope="col">Status</th></tr></thead>
  <tbody>{rows.map(row => <tr key={row.id}>
    <th scope="row"><strong>{row.heading}</strong><p>{row.actor} · {row.system}</p><p className={styles.muted}>Starts when: {row.trigger}</p><p>{row.description}</p></th>
    <td>{row.requirements.map(req => <div key={req.id} className={styles.cellStep}>
      <p><strong>{req.kindLabel}{req.critical ? " (critical)" : ""}.</strong> {req.statement}</p><blockquote className={styles.quote}>{req.quote}</blockquote></div>)}</td>
    <td>{row.eliminatedReason ? <p><strong>Eliminated by design.</strong> {row.eliminatedReason}</p>
      : row.steps.length ? row.steps.map(view => <ToBeCell key={view.anchor} view={view} />) : <p>No To-Be step covers this current step.</p>}</td>
    <td>{row.steps.length ? row.steps.map(view => <div key={view.anchor} className={styles.cellStep}><p className={styles.muted}>{view.heading}</p><Implementation implementation={view.implementation} /></div>) : "-"}</td>
    <td><span className={styles.badge} data-status={row.status.startsWith("Blocked") || row.status === "Not covered" ? "BLOCKED" : "REVIEW"}>{row.status}</span></td>
  </tr>)}</tbody></Table>;
}

function Step({ view, labels }: { view: StepView; labels: Record<string, string> }) {
  const { step } = view;
  return <section id={view.anchor} className={styles.step} aria-labelledby={`${view.anchor}-h`}>
    <h3 id={`${view.anchor}-h`}>{view.heading} <span className={styles.badge} data-status={view.status.code}>{view.status.label}</span></h3>
    <dl className={styles.facts}>
      <dt>Replaces</dt><dd>{view.asIsNames.join(", ") || "-"}</dd><dt>Actor</dt><dd>{step.actor}</dd><dt>Starts when</dt><dd>{step.trigger}</dd>
      <dt>Documents in</dt><dd>{step.inputDocuments.join(", ")}</dd><dt>Documents out</dt><dd>{step.outputDocuments.join(", ")}</dd>
      <dt>Inventory effect</dt><dd>{step.effects.inventory}</dd><dt>Financial effect</dt><dd>{step.effects.financial}</dd><dt>Ownership effect</dt><dd>{step.effects.ownership}</dd>{step.effects.accountingEntry && <><dt>Accounting entry</dt><dd>{step.effects.accountingEntry}</dd></>}
      <dt>Added value</dt><dd>{step.addedValue}</dd></dl>
    {view.status.blockers.length > 0 && <div className={styles.blockedNote} role="note"><strong>Blocked:</strong> {view.status.blockers.map(item => item.label).join(" ")}</div>}
    <h4>SAP realization</h4><Implementation implementation={view.implementation} />
    <h4>Actions</h4>
    <Table label={`${view.heading} actions`}><thead><tr><th scope="col">Actor</th><th scope="col">System</th><th scope="col">Operation</th><th scope="col">Fields</th></tr></thead>
      <tbody>{step.actions.map((action, index) => <tr key={index}><td>{action.actor}</td><td>{action.system}</td><td>{action.operation}</td><td>{action.fields.join(", ")}</td></tr>)}</tbody></Table>
    <h4>Business rules</h4>
    <Table label={`${view.heading} business rules`}><thead><tr><th scope="col">Rule</th><th scope="col">Condition</th><th scope="col">Response</th></tr></thead>
      <tbody>{step.businessRules.map(rule => <tr key={rule.id}><td><code className={styles.code}>{rule.id}</code></td><td>{rule.condition}</td><td>{rule.response}</td></tr>)}</tbody></Table>
    <h4>Exceptions</h4>
    {step.exceptions.length ? <Table label={`${view.heading} exceptions`}><thead><tr><th scope="col">Condition</th><th scope="col">Response</th><th scope="col">Owner</th></tr></thead>
      <tbody>{step.exceptions.map((item, index) => <tr key={index}><td>{item.condition}</td><td>{item.response}</td><td>{item.owner}</td></tr>)}</tbody></Table>
      : <p>Not applicable: {step.exceptionsNotApplicableReason}</p>}
    <h4>Acceptance tests <span className={styles.badge} data-status="SPEC">{TEST_LABEL}</span></h4>
    <p className={styles.muted}>These are written specifications. None of them has been run.</p>
    <Table label={`${view.heading} acceptance tests`}><thead><tr><th scope="col">Test</th><th scope="col">Given</th><th scope="col">When</th><th scope="col">Then</th><th scope="col">Requirements</th><th scope="col">Status</th></tr></thead>
      <tbody>{step.acceptanceTests.map(test => <tr key={test.id}><td><code className={styles.code}>{test.id}</code><p className={styles.muted}>{testKindLabel(test.kind)}</p></td>
        <td>{test.given}</td><td>{test.when}</td><td>{test.then}</td><td>{test.requirementIds.map(id => labels[id] ?? "Unknown requirement").join(", ")}</td><td>{TEST_LABEL}</td></tr>)}</tbody></Table>
  </section>;
}

const RegisterTable = ({ label, items }: { label: string; items: Register[] }) => items.length === 0 ? <p>None.</p> :
  <Table label={label}><thead><tr><th scope="col">Item</th><th scope="col">Owner</th><th scope="col">Affects</th><th scope="col">State</th></tr></thead>
    <tbody>{items.map(item => <tr key={item.id}><td>{item.text}</td><td>{item.owner}</td><td>{item.affects}</td><td>{item.state}</td></tr>)}</tbody></Table>;

export function ConsultantReport({ model, downloads }: { model: ReportModel; downloads: { markdown: string; csv: string; back: string } }) {
  const { header, summary } = model;
  return <article className={styles.report} aria-labelledby="report-title">
    <header className={styles.head}>
      <p className={styles.eyebrow}>{header.project} · {header.client}</p>
      <h1 id="report-title">To-Be design report: {header.processName}</h1>
      <p className={styles.status} data-status={model.status} data-testid="report-status" role="status">
        <strong>Review status: {model.statusCopy.label}.</strong> {model.statusCopy.detail}</p>
      {model.catalogWarning && <p className={styles.status} data-testid="report-catalog-warning" role="alert"><strong>{model.catalogWarning}</strong></p>}
      <dl className={styles.facts}>
        <dt>Process variant</dt><dd>{header.variant}</dd><dt>Discovery revision</dt><dd>{header.sourceRevision}</dd>
        <dt>Target product</dt><dd>{header.product}</dd><dt>Target release</dt><dd>{header.release}</dd>
        <dt>Generated</dt><dd>{header.generatedAt}</dd><dt>Blockers</dt><dd>{model.blockers.length}</dd></dl>
      <div className={styles.actions}>
        <a href={downloads.markdown} download className={styles.button}>Download Markdown</a>
        <a href={downloads.csv} download className={styles.button}>Download traceability CSV</a>
        <PrintButton className={styles.button} /><a href={downloads.back}>Back to the conversation</a>
      </div>
      <nav aria-label="Report sections" className={styles.toc}>{[["summary", "Summary"], ["comparison", "As-Is vs To-Be"], ["steps", "To-Be steps"],
        ["traceability", "Traceability"], ["registers", "Registers"]].map(([id, text]) => <a key={id} href={`#${id}`}>{text}</a>)}</nav>
    </header>

    {model.blockersByCategory.length > 0 && <section aria-labelledby="blockers-h" className={styles.section}>
      <h2 id="blockers-h">Blockers by category</h2>
      {model.blockersByCategory.map(group => <div key={group.category}><h3>{group.category} ({group.items.length})</h3>
        <ul className={styles.tight}>{group.items.map((item, index) => <li key={index}>
          {item.anchor ? <a href={`#${item.anchor}`}>{item.subject}</a> : item.subject}: {item.label}{item.detail ? ` ${item.detail}` : ""} <span className={styles.code}>{item.code} at {item.path}</span></li>)}</ul></div>)}
    </section>}

    <section id="summary" aria-labelledby="summary-h" className={styles.section}>
      <h2 id="summary-h">Executive summary</h2>
      <p>{summary.asIsSteps} current steps ({summary.eliminated} eliminated by design) are redesigned as <strong>{summary.toBeSteps} To-Be steps</strong> with{" "}
        {summary.rules} business rules, {summary.exceptions} exceptions and {summary.tests} acceptance-test specifications ({TEST_LABEL.toLowerCase()}).</p>
      <Table label="Requirement coverage"><thead><tr><th scope="col">Requirement coverage</th><th scope="col">Count</th></tr></thead><tbody>
        <tr><td>Total requirements</td><td>{summary.requirements}</td></tr><tr><td>Implemented in the To-Be design</td><td>{summary.implemented}</td></tr>
        <tr><td>Deferred (approved decision)</td><td>{summary.deferred}</td></tr><tr><td>Rejected (approved decision)</td><td>{summary.rejected}</td></tr>
        <tr><td>Open questions and conflicts</td><td>{summary.openQuestions + summary.conflicts}</td></tr></tbody></Table>
    </section>

    <section id="comparison" aria-labelledby="comparison-h" className={styles.section}>
      <h2 id="comparison-h">As-Is vs To-Be comparison</h2><ComparisonTable rows={model.comparison} />
    </section>
    <section id="steps" aria-labelledby="steps-h" className={styles.section}>
      <h2 id="steps-h">To-Be steps in detail</h2>{model.steps.map(view => <Step key={view.anchor} view={view} labels={model.requirementLabels} />)}
    </section>
    <section id="traceability" aria-labelledby="traceability-h" className={styles.section}>
      <h2 id="traceability-h">Traceability matrix</h2>
      <Table label="Traceability matrix"><thead><tr><th scope="col">Requirement</th><th scope="col">Disposition</th><th scope="col">To-Be steps</th><th scope="col">Rules</th><th scope="col">Tests (specified)</th></tr></thead>
        <tbody>{model.traceability.map(row => <tr key={row.id}>
          <th scope="row"><p><strong>{row.label}</strong> · {row.kindLabel}{row.critical ? " (critical)" : ""} · {row.asIs}</p><p>{row.statement}</p></th>
          <td>{row.disposition}<p className={styles.muted}>{row.rationale}</p></td><td><List items={row.steps} /></td><td><List items={row.rules} /></td><td>{row.tests.join(", ") || "None"}</td></tr>)}</tbody></Table>
    </section>
    <section id="registers" aria-labelledby="registers-h" className={styles.section}>
      <h2 id="registers-h">Registers</h2>
      <h3>Open decisions and questions</h3><RegisterTable label="Open decisions and questions" items={model.registers.questions} />
      <h3>Source conflicts</h3><RegisterTable label="Source conflicts" items={model.registers.conflicts} />
      <h3>SAP validation points</h3><RegisterTable label="SAP validation points" items={model.registers.sapPoints} />
    </section>
  </article>;
}
