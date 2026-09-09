/** Indentation guide for a nested call row — ports createTreeGuideHtml(). */
export function TreeGuide({ depth }: { depth: number }) {
  if (!depth || depth <= 0) return <span className="tree-branch">▸</span>;
  return (
    <>
      <span className="tree-guide-indent">
        {Array.from({ length: depth - 1 }, (_, i) => (
          <span key={i} className="tree-segment" />
        ))}
      </span>
      <span className="tree-branch">├──</span>
    </>
  );
}
