import ReactMarkdown from "react-markdown";
import { HighlightedChildren } from "./SearchPresentation";

export default function PreviewTaskTitle({ markdown, terms, onOpenLink }: {
  markdown: string;
  terms: string[];
  onOpenLink: (href?: string) => void;
}) {
  return <ReactMarkdown allowedElements={["a"]} unwrapDisallowed skipHtml components={{
    p: ({ children }) => <HighlightedChildren terms={terms}>{children}</HighlightedChildren>,
    a: ({ href, children }) => <a href={href} onClick={(event) => {
      event.preventDefault();
      onOpenLink(href);
    }}><HighlightedChildren terms={terms}>{children}</HighlightedChildren></a>,
  }}>{markdown}</ReactMarkdown>;
}
