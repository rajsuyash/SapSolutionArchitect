"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { WorkspaceView } from "./consultant-api";
import { waitingCopy } from "./consultant-summary";
import styles from "./consultant.module.css";
import { SupportLink } from "./support";

type Message = WorkspaceView["messages"][number];
type Question = WorkspaceView["questions"][number];
type Props = { problem: string; messages: Message[]; questions: Question[]; waiting: boolean; canEdit: boolean;
  needsRetry: boolean; proposalCount: number; onReview: () => void; failure: string | null; error: string; support: boolean; onSend: (text: string) => Promise<boolean>; onRetry: () => void };

/** The stored reply is "acknowledgement\n\nquestion why-it-matters\n\n…". Re-pair each paragraph with its question. */
function ConsultantMessage({ message, questions }: { message: Message; questions: Question[] }) {
  const [reply, ...rest] = message.text.split("\n\n");
  return <>
    <p>{reply}</p>
    {message.note && <p data-testid="to-be-note"><strong>{message.note}</strong></p>}
    {rest.length > 0 && <ol className={styles.questions}>{rest.map((paragraph, index) => {
      const match = questions.find(question => `${question.question} ${question.whyItMatters}` === paragraph);
      return <li key={index}>{match
        ? <><p className={styles.question}>{match.question}</p><p className={styles.why}><strong>Why this matters:</strong> {match.whyItMatters}</p></>
        : <p>{paragraph}</p>}</li>;
    })}</ol>}
  </>;
}

export function ConsultantChat({ problem, messages, questions, waiting, canEdit, needsRetry, proposalCount, onReview, failure, error, support, onSend, onRetry }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages.length, waiting]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = text.trim();
    if (!value || sending || waiting) return;
    setSending(true);
    const sent = await onSend(value);
    setSending(false);
    if (sent) setText("");
    input.current?.focus(); // keep the keyboard where the conversation continues
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
  }
  const blocked = sending || waiting;
  return <div className={styles.chat}>
    <div ref={log} className={styles.log} role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation with the consultant" tabIndex={0}>
      <div className={styles.bubble} data-role="brief">
        <p className={styles.who}>Project brief</p>
        <p className={styles.clamp}>{problem}</p>
      </div>
      {messages.length === 0 && <div className={styles.bubble} data-role="assistant">
        <p className={styles.who}>Consultant</p>
        <p>Tell me about the business problem in your own words: what happens today, where it hurts, and what you would like to be different. I will ask a few focused questions at a time.</p>
      </div>}
      {messages.map(message => <div key={message.id} className={styles.bubble} data-role={message.role} data-testid={`message-${message.role}`}>
        <p className={styles.who}>{message.role === "user" ? "You" : "Consultant"}</p>
        {message.role === "user" ? <p className={styles.pre}>{message.text}</p> : <ConsultantMessage message={message} questions={questions} />}
      </div>)}
      {waiting && <p role="status" className={styles.thinking} data-testid="consultant-working">The consultant is reading your message… You can leave this page and return later.</p>}
    </div>
    {/* The way to reach us sits inside the last alert shown, so it is read together with the failure it belongs to. */}
    {failure && <div role="alert" className={styles.alert}><p>{failure}</p>{support && !error && <p><SupportLink /></p>}</div>}
    {error && <div role="alert" className={styles.alert}><p>{error}</p>{support && <p><SupportLink /></p>}</div>}
    {support && !failure && !error && <p className={styles.notice}>Need help with this? <SupportLink /></p>}
    {needsRetry && canEdit && <button type="button" className={styles.small} onClick={onRetry}>Ask the consultant to reply again</button>}
    {proposalCount > 0
      ? <p className={styles.notice} data-testid="review-pointer">{waitingCopy(proposalCount)} <button type="button" className={styles.small} onClick={onReview}>Review them</button></p>
      : !waiting && messages.at(-1)?.role === "assistant" && !messages.at(-1)!.text.includes("\n\n")
        && <p className={styles.notice} data-testid="next-hint">The consultant has no new questions. Answer in your own words below, or open the Summary to fill in items directly.</p>}
    {canEdit ? <form onSubmit={(event) => void submit(event)} className={styles.composer}>
      <label htmlFor="consultant-message">Your message</label>
      <textarea id="consultant-message" ref={input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        rows={4} maxLength={20000} placeholder="Describe the problem, answer a question, or correct something…" />
      <div className={styles.row}>
        <button type="submit" className={styles.primary} disabled={blocked || !text.trim()}>{sending ? "Sending…" : "Send"}</button>
        <span className={styles.help}>Ctrl or Cmd + Enter also sends.</span>
      </div>
    </form> : <p className={styles.muted}>You have read-only access to this conversation.</p>}
  </div>;
}
