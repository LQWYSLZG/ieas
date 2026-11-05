import { Link } from "react-router-dom";
import { asset } from "../lib/asset";

export function AssistantHeader({ icon, title }: { icon: string; title: string }) {
  return <>
    <Link to="/" className="assistant-back" aria-label="Back to suite home">
      <svg aria-hidden="true" viewBox="0 0 112 40">
        <g><path d="M0 9h15l8 8h9m-32 13h11l7-7h10M112 9H96l-8 8h-7m31 13H99l-7-7h-8" />
          <circle cx="34" cy="17" r="1.5"/><circle cx="79" cy="17" r="1.5"/></g>
        <path className="back-pulse" d="M0 9h15l8 8h9m80 13H99l-7-7h-8" />
      </svg>
      <span>BACK</span>
    </Link>
    <header className="assistant-header"><img src={asset(icon)} alt="" /><h1>{title}</h1></header>
  </>;
}
