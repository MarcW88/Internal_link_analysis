export type ContentBlock = { position: number; heading: string | null; content: string };

export function extractContentBlocks(markdown: string) {
  const blocks: ContentBlock[] = [];
  let heading: string | null = null;
  let paragraph: string[] = [];

  const flush = () => {
    const content = paragraph.join(" ").replace(/\s+/g, " ").trim();
    if (content.length >= 80) blocks.push({ position: blocks.length, heading, content });
    paragraph = [];
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      flush();
      heading = match[1].trim();
    } else if (!line) {
      flush();
    } else if (!/^(!?\[|[-*_]{3,}$)/.test(line)) {
      paragraph.push(line.replace(/^[-*+]\s+/, ""));
    }
  }
  flush();
  return blocks;
}
