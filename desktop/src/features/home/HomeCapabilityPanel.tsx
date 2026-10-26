/** 首页右栏：用结果语言说明产品能做什么，不在这里展开模型或运行环境。 */
import {
  BranchesOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import type { ReactElement, ReactNode } from 'react';
import { tokens } from '../../styles/theme';

const CAPABILITIES: readonly {
  readonly icon: ReactNode;
  readonly title: string;
  readonly desc: string;
  readonly tag: string;
}[] = [
  {
    icon: <BranchesOutlined />,
    title: '高光片段',
    desc: '保留原声，把冲突最密的镜头接起来',
    tag: '原片',
  },
  {
    icon: <FileTextOutlined />,
    title: '剧情解说',
    desc: '用文案和配音讲清一集的故事',
    tag: '解说',
  },
  {
    icon: <PlayCircleOutlined />,
    title: '成品导出',
    desc: '方案定下后直接渲染并收进成品库',
    tag: '成片',
  },
];

export function HomeCapabilityPanel(): ReactElement {
  return (
    <aside
      aria-label="可生成的成品类型"
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: tokens.spaceXl,
        background: tokens.homeCardSheen,
        border: `1px solid ${tokens.borderSecondary}`,
        borderRadius: tokens.radiusCard,
        boxShadow: tokens.shadowCard,
      }}
    >
      <div
        style={{
          fontSize: tokens.text.cardTitle.size,
          lineHeight: tokens.text.cardTitle.leading,
          fontWeight: tokens.text.cardTitle.weight,
          color: tokens.textPrimary,
        }}
      >
        最后能拿到这三种片子
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          marginTop: tokens.spaceLg,
        }}
      >
        {CAPABILITIES.map((item, index) => (
          <CapabilityRow key={item.title} item={item} last={index === CAPABILITIES.length - 1} />
        ))}
      </div>
      <div
        style={{
          marginTop: 'auto',
          paddingTop: tokens.spaceLg,
          fontSize: tokens.text.meta.size,
          lineHeight: tokens.text.meta.leading,
          color: tokens.textTertiary,
        }}
      >
        同一部剧，可以按不同叙事方式生成多个版本。
      </div>
    </aside>
  );
}

function CapabilityRow({
  item,
  last,
}: {
  item: (typeof CAPABILITIES)[number];
  last: boolean;
}): ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr) auto',
        alignItems: 'start',
        gap: tokens.spaceMd,
        padding: `${tokens.spaceMd} 0`,
        borderBottom: last ? 'none' : `1px solid ${tokens.borderSecondary}`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: tokens.spaceXl,
          height: tokens.spaceXl,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: tokens.radiusThumb,
          background: tokens.accentSoft,
          color: tokens.colorPrimary,
          fontSize: tokens.glyph.iconMd,
        }}
      >
        {item.icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: tokens.text.body.size,
            lineHeight: tokens.text.body.leading,
            fontWeight: tokens.text.body.weightActive,
            color: tokens.textPrimary,
          }}
        >
          {item.title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: tokens.spaceXs,
            fontSize: tokens.text.meta.size,
            lineHeight: tokens.text.meta.leading,
            color: tokens.textTertiary,
          }}
        >
          {item.desc}
        </span>
      </span>
      <span
        style={{
          padding: `${tokens.spaceXs} ${tokens.spaceSm}`,
          borderRadius: tokens.radiusChip,
          background: tokens.bgInput,
          color: tokens.textTertiary,
          fontSize: tokens.text.badge.size,
          lineHeight: tokens.text.badge.leading,
        }}
      >
        {item.tag}
      </span>
    </div>
  );
}
