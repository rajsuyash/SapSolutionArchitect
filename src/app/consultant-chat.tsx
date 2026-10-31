"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { WorkspaceView } from "./consultant-api";
import styles from "./consultant.module.css";

type Message = WorkspaceView["messages"][number];
type Question = WorkspaceView["questions"][number];
type Props = { problem: string; messages: Message[]; questions: Question[]; waiting: boolean; canEdit: boolean;
  needsRetry: boolean; failure: string | null; error: string; onSend: (text: string) => Promise<boolean>; onRetry: () => void };

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

export function ConsultantChat({ problem, messages, questions, waiting, canEdit, needsRetry, failure, error, onSend, onRetry }: Props) {
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
    {failure && <div role="alert" className={styles.alert}><p>{failure}</p></div>}
    {error && <div role="alert" className={styles.alert}><p>{error}</p></div>}
    {needsRetry && canEdit && <button type="button" className={styles.small} onClick={onRetry}>Ask the consultant to reply again</button>}
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
