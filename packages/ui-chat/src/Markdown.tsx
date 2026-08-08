// ============================================================================
// packages/ui-chat/src/Markdown.tsx
// assistant 消息的 markdown 渲染:react-markdown + remark-gfm(表格/列表/删除线)
// + remark-math + rehype-katex(数学公式) + rehype-highlight(代码高亮)。
// highlight.js / katex 是本包直接依赖，从这里引主题 CSS(跨到 apps/web 引会因
// pnpm 严格布局解析不到)。Vite 会把它并入 bundle。
// ============================================================================

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github.css";
import "katex/dist/katex.min.css";

export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className="helios-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
