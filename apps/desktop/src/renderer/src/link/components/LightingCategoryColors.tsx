export function LightingCategoryColors({sections}:{sections:readonly ('front'|'rim'|'effect')[]}):JSX.Element|null{
  if(!sections.length)return null;
  return <span className="cue-category-colors" aria-label={`分类：${(['front','rim','effect'] as const).filter(value=>sections.includes(value)).map(value=>({front:'面光',rim:'轮廓',effect:'效果'})[value]).join('、')}`}>
    {(['front','rim','effect'] as const).filter(value=>sections.includes(value)).map(value=><i key={value} data-section={value} title={{front:'面光',rim:'轮廓',effect:'效果'}[value]}/>)}
  </span>;
}
