import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, {
          throwOnError: false,
          trust: false
        }]]}
        components={{
          a: ({ href, children: linkChildren, ...props }) => {
            const external = href?.startsWith("https://") || href?.startsWith("http://");
            return (
              <a
                {...props}
                href={href}
                target={external ? "_blank" : undefined}
                rel={external ? "noreferrer" : undefined}
              >
                {linkChildren}
              </a>
            );
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
