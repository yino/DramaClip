/** 无剧时的首页引导（规格 desktop-workbench 空态）。
 *
 * 画面参考工作台的“素材进来、成品出去”结构：左侧只留一个建剧动作，
 * 右侧用镜头条说明会得到什么；下方再解释素材准备方式。
 * 所有承诺都必须对应已经存在的能力，素材仍只登记原路径。
 */
import {
  CheckOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  PlayCircleFilled,
} from '@ant-design/icons';
import { Button } from 'antd';
import type { ReactElement, ReactNode } from 'react';
import { layout, tokens } from '../../styles/theme';

const REEL: readonly {
  readonly title: string;
  readonly caption: string;
  readonly background: string;
}[] = [
  { title: '原声高光', caption: '先看冲突', background: tokens.homePosterFallback },
  { title: '解说成片', caption: '再讲故事', background: tokens.homePosterWarm },
  { title: '竖屏成品', caption: '直接发布', background: tokens.homePosterDim },
];

const GUIDE: readonly {
  readonly step: string;
  readonly status: string;
  readonly title: string;
  readonly desc: string;
  readonly note: string;
}[] = [
  {
    step: '01',
    status: '文件名',
    title: '整理剧集',
    desc: '按 EP01、EP02 的顺序命名，系统会自然排序。',
    note: '不用手动拖动',
  },
  {
    step: '02',
    status: '格式',
    title: '选择素材',
    desc: '支持 MP4、MOV、AVI、MKV 等常见视频格式。',
    note: '可以一次多选',
  },
  {
    step: '03',
    status: '项目',
    title: '开始建剧',
    desc: '文件夹名会自动填入剧名，建好后就能逐集处理。',
    note: '原文件不动',
  },
];

export function EmptyWorkbench({
  creating,
  onCreate,
}: {
  creating: boolean;
  onCreate: () => void;
}): ReactElement {
  return (
    <section
      className="home-empty-card"
      style={{
        position: 'relative',
        minWidth: 0,
        padding: layout.home.heroPadding,
        overflow: 'hidden',
        background: `${tokens.homeHalo}, ${tokens.homeCardSheen}`,
        border: `1px solid ${tokens.borderSecondary}`,
        borderRadius: tokens.radiusCard,
        boxShadow: tokens.shadowCard,
      }}
    >
      <div style={{ minWidth: 0, maxWidth: 620 }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: tokens.spaceSm,
            padding: `${tokens.spaceXs} ${tokens.spaceSm}`,
            borderRadius: tokens.radiusChip,
            background: tokens.accentSoft,
            color: tokens.textSecondary,
            fontSize: tokens.text.badge.size,
            lineHeight: tokens.text.badge.leading,
          }}
        >
          <span
            style={{
              width: tokens.spaceSm,
              height: tokens.spaceSm,
              borderRadius: tokens.radiusChip,
              background: tokens.colorPrimary,
            }}
          />
          第一次使用
        </div>
        <h1
          style={{
            margin: 0,
            marginTop: tokens.spaceLg,
            fontSize: tokens.text.heroTitle.size,
            lineHeight: tokens.text.heroTitle.leading,
            fontWeight: tokens.text.heroTitle.weight,
            letterSpacing: '-0.025em',
            color: tokens.textPrimary,
          }}
        >
          把整部短剧放进来，
          <br />
          它会整理成能剪的项目
        </h1>
        <p
          style={{
            margin: 0,
            marginTop: tokens.spaceMd,
            fontSize: tokens.text.body.size,
            lineHeight: tokens.text.body.leading,
            color: tokens.textSecondary,
          }}
        >
          选择多个视频文件即可建剧，素材留在原位置。
        </p>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spaceLg,
            flexWrap: 'wrap',
            marginTop: tokens.space2xl,
          }}
        >
          <Button
            type="primary"
            size="large"
            icon={<FolderAddOutlined />}
            loading={creating}
            disabled={creating}
            onClick={onCreate}
          >
            新增项目
          </Button>
          <span
            style={{
              fontSize: tokens.text.meta.size,
              lineHeight: tokens.text.meta.leading,
              color: tokens.textTertiary,
            }}
          >
            文件夹名会作为剧名，可稍后修改
          </span>
        </div>
      </div>
      <FilmStrip />
    </section>
  );
}

function FilmStrip(): ReactElement {
  return (
    <div
      className="home-film-strip"
      aria-hidden="true"
      style={{
        gap: tokens.spaceSm,
        marginLeft: tokens.spaceXl,
        transform: 'rotate(1.2deg)',
      }}
    >
      {REEL.map((item, index) => (
        <ReelCard key={item.title} item={item} index={index} />
      ))}
    </div>
  );
}

function ReelCard({
  item,
  index,
}: {
  item: (typeof REEL)[number];
  index: number;
}): ReactElement {
  return (
    <span
      style={{
        position: 'relative',
        width: layout.home.heroPreviewWidth,
        height: layout.home.heroPreviewHeight,
        overflow: 'hidden',
        borderRadius: tokens.radiusControl,
        border: `1px solid ${tokens.homeHairline}`,
        background: item.background,
        boxShadow: tokens.shadowCard,
        transform: index === 1 ? 'translateY(-8px)' : undefined,
      }}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          background: tokens.homePreviewScrim,
        }}
      />
      <PlayCircleFilled
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          color: tokens.textPrimary,
          fontSize: tokens.glyph.poster,
        }}
      />
      <span
        style={{
          position: 'absolute',
          left: tokens.spaceSm,
          right: tokens.spaceSm,
          bottom: tokens.spaceSm,
          color: tokens.textPrimary,
        }}
      >
        <span
          style={{
            display: 'block',
            fontSize: tokens.text.badge.size,
            lineHeight: tokens.text.badge.leading,
            fontWeight: tokens.text.badge.weightActive,
          }}
        >
          {item.title}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: tokens.spaceXs,
            fontSize: tokens.text.badge.size,
            lineHeight: tokens.text.badge.leading,
            color: tokens.textSecondary,
          }}
        >
          {item.caption}
        </span>
      </span>
    </span>
  );
}

export function HomeGuide(): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceMd }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: tokens.spaceLg,
          flexWrap: 'wrap',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: tokens.text.sectionTitle.size,
            lineHeight: tokens.text.sectionTitle.leading,
            fontWeight: tokens.text.sectionTitle.weight,
            color: tokens.textPrimary,
          }}
        >
          开始前，先确认这三件事
        </h2>
        <span
          style={{
            fontSize: tokens.text.meta.size,
            lineHeight: tokens.text.meta.leading,
            color: tokens.textTertiary,
          }}
        >
          不需要复制素材，也不需要先整理目录。
        </span>
      </div>
      <div className="home-guide-grid" style={{ gap: tokens.spaceMd }}>
        {GUIDE.map((item) => (
          <GuideCard key={item.step} item={item} />
        ))}
      </div>
      <MaterialPattern />
    </div>
  );
}

function GuideCard({ item }: { item: (typeof GUIDE)[number] }): ReactElement {
  return (
    <article
      style={{
        minWidth: 0,
        minHeight: layout.home.guideHeight,
        display: 'flex',
        flexDirection: 'column',
        padding: tokens.spaceXl,
        background: tokens.bgContainer,
        border: `1px solid ${tokens.borderSecondary}`,
        borderRadius: tokens.radiusCard,
        boxShadow: tokens.shadowCard,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spaceSm }}>
        <span
          style={{
            width: tokens.spaceSm,
            height: tokens.spaceSm,
            borderRadius: tokens.radiusChip,
            background: tokens.colorPrimary,
          }}
        />
        <span
          style={{
            fontSize: tokens.text.badge.size,
            lineHeight: tokens.text.badge.leading,
            color: tokens.textSecondary,
          }}
        >
          {item.status}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: tokens.text.badge.size,
            lineHeight: tokens.text.badge.leading,
            color: tokens.textTertiary,
          }}
        >
          {item.step}
        </span>
      </div>
      <h3
        style={{
          margin: 0,
          marginTop: tokens.spaceXl,
          fontSize: tokens.text.cardTitle.size,
          lineHeight: tokens.text.cardTitle.leading,
          fontWeight: tokens.text.cardTitle.weight,
          color: tokens.textPrimary,
        }}
      >
        {item.title}
      </h3>
      <p
        style={{
          margin: 0,
          marginTop: tokens.spaceSm,
          fontSize: tokens.text.meta.size,
          lineHeight: tokens.text.meta.leading,
          color: tokens.textTertiary,
        }}
      >
        {item.desc}
      </p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spaceSm,
          marginTop: 'auto',
          paddingTop: tokens.spaceLg,
          fontSize: tokens.text.meta.size,
          lineHeight: tokens.text.meta.leading,
          color: tokens.textSecondary,
        }}
      >
        <CheckOutlined style={{ color: tokens.colorSuccess }} />
        {item.note}
      </div>
    </article>
  );
}

function MaterialPattern(): ReactElement {
  return (
    <div
      className="home-guide-info"
      style={{
        gap: tokens.space2xl,
        padding: tokens.spaceXl,
        background: tokens.bgContainer,
        border: `1px solid ${tokens.borderSecondary}`,
        borderRadius: tokens.radiusCard,
      }}
    >
      <div>
        <div
          style={{
            fontSize: tokens.text.cardTitle.size,
            lineHeight: tokens.text.cardTitle.leading,
            fontWeight: tokens.text.cardTitle.weight,
            color: tokens.textPrimary,
          }}
        >
          素材长这样就行
        </div>
        <div
          style={{
            marginTop: tokens.spaceMd,
            padding: tokens.spaceLg,
            borderRadius: tokens.radiusControl,
            background: tokens.bgInput,
            border: `1px solid ${tokens.borderSecondary}`,
            fontSize: tokens.text.meta.size,
            lineHeight: tokens.text.body.leading,
            color: tokens.textSecondary,
          }}
        >
          <div>
            <FolderOpenOutlined style={{ marginRight: tokens.spaceSm, color: tokens.textTertiary }} />
            真龙/ ← 文件夹名就是剧名
          </div>
          <div style={{ paddingLeft: tokens.spaceXl, color: tokens.textTertiary }}>
            ├─ EP01.mp4
            <br />├─ EP02.mp4
            <br />└─ EP03.mp4
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceMd }}>
        <PatternRule title="自然排序" desc="EP01 到 EP99 会按数字顺序识别，不用手动拖。" icon={<CheckOutlined />} />
        <PatternRule title="常见格式" desc="MP4、MOV、AVI、MKV 都能在选文件时加入项目。" icon={<CheckOutlined />} />
        <PatternRule title="素材不动" desc="只登记原文件路径，不复制，也不改变目录结构。" icon={<CheckOutlined />} />
      </div>
    </div>
  );
}

function PatternRule({
  title,
  desc,
  icon,
}: {
  title: string;
  desc: string;
  icon: ReactNode;
}): ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: tokens.spaceSm }}>
      <span
        style={{
          width: tokens.spaceXl,
          height: tokens.spaceXl,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: tokens.radiusChip,
          background: tokens.accentSoft,
          color: tokens.colorPrimary,
          fontSize: tokens.glyph.icon,
        }}
      >
        {icon}
      </span>
      <span>
        <span
          style={{
            display: 'block',
            fontSize: tokens.text.body.size,
            lineHeight: tokens.text.body.leading,
            fontWeight: tokens.text.body.weightActive,
            color: tokens.textPrimary,
          }}
        >
          {title}
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
          {desc}
        </span>
      </span>
    </div>
  );
}
