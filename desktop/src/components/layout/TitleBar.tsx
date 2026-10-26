/** 自定义标题栏：拖拽区 + 项目搜索 + 窗口控制（frame:false 配套）。 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BorderOutlined,
  CloseOutlined,
  MinusOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { projectApi, windowControl } from '../../services/client';
import { rememberDrama } from '../../stores/lastDrama';
import { summarizeJobs, useJobsStore } from '../../stores/jobs';
import { hoverBg } from '../../styles/mixins';
import { layout, tokens } from '../../styles/theme';
import { dramaEntryPath } from '../../app/routes';
import logo from '../../assets/logo.png';

export function TitleBar(): React.ReactElement {
  return (
    <div
      style={{
        height: layout.titleBar.height,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spaceLg,
        padding: `0 ${layout.titleBar.paddingX}`,
        background: tokens.bgSidebar,
        borderBottom: `1px solid ${tokens.borderSecondary}`,
        WebkitAppRegion: 'drag',
      } as CSSProperties}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spaceSm }}>
        <img
          src={logo}
          alt="DramaClip"
          style={{
            width: layout.titleBar.brand,
            height: layout.titleBar.brand,
            borderRadius: tokens.radiusControl,
            display: 'block',
          }}
        />
        <span
          style={{
            fontWeight: 700,
            fontSize: tokens.text.body.size,
            lineHeight: tokens.text.body.leading,
            color: tokens.textPrimary,
          }}
        >
          DramaClip
        </span>
      </div>
      <div
        style={{
          width: layout.titleBar.search.width,
          minWidth: 180,
          maxWidth: 'calc(100vw - 700px)',
          flexShrink: 1,
          marginLeft: layout.titleBar.search.leftOffset,
        }}
      >
        <ProjectSearch />
      </div>
      <TitleMeta />
      <WindowButtons />
    </div>
  );
}

/** 顶栏状态只回答两件事：有没有任务在跑、素材在哪里处理。 */
function TitleMeta(): React.ReactElement {
  const jobs = useJobsStore((state) => state.jobs);
  const available = useJobsStore((state) => state.available);
  const error = useJobsStore((state) => state.error);
  const setDrawerOpen = useJobsStore((state) => state.setDrawerOpen);
  const summary = summarizeJobs(jobs);
  const jobLabel = !available
    ? '任务 · —'
    : summary.active > 0
      ? `任务 · ${String(summary.active)} 项在跑`
      : summary.failed > 0
        ? `任务 · ${String(summary.failed)} 项失败`
        : '没有任务';

  return (
    <div
      style={{
        marginLeft: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spaceSm,
        WebkitAppRegion: 'no-drag',
      } as CSSProperties}
    >
      <MetaPill
        icon={
          <span
            style={{
              width: tokens.spaceSm,
              height: tokens.spaceSm,
              borderRadius: tokens.radiusChip,
              background: available ? tokens.colorInfo : tokens.textTertiary,
              display: 'block',
            }}
          />
        }
        label={jobLabel}
        title={!available ? (error ?? '任务状态未知') : '打开任务中心'}
        onClick={() => {
          setDrawerOpen(true);
        }}
      />
      <MetaPill
        icon={<SafetyCertificateOutlined />}
        label="素材本地处理"
        title="视频素材保留在本机"
      />
    </div>
  );
}

function MetaPill({
  icon,
  label,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  onClick?: () => void;
}): React.ReactElement {
  const style: CSSProperties = {
    height: layout.controlHeight.md,
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spaceSm,
    padding: `0 ${tokens.spaceMd}`,
    borderRadius: tokens.radiusChip,
    border: `1px solid ${tokens.border}`,
    background: tokens.bgInput,
    color: tokens.textSecondary,
    fontSize: tokens.text.meta.size,
    lineHeight: tokens.text.meta.leading,
    cursor: onClick === undefined ? 'default' : 'pointer',
  };
  return onClick === undefined ? (
    <span title={title} style={style}>
      {icon}
      {label}
    </span>
  ) : (
    <button type="button" title={title} style={style} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

const SEARCH_ICON = (
  <SearchOutlined
    style={{
      position: 'absolute',
      left: layout.titleBar.search.iconInset,
      top: '50%',
      transform: 'translateY(-50%)',
      fontSize: tokens.glyph.iconMd,
      color: tokens.textTertiary,
    }}
  />
);

const SEARCH_BADGE = (
  <span
    style={{
      position: 'absolute',
      right: layout.titleBar.search.iconInset,
      top: '50%',
      transform: 'translateY(-50%)',
      fontSize: tokens.text.badge.size,
      lineHeight: tokens.text.badge.leading,
      padding: `${String(layout.chip.paddingBlock)}px ${layout.chip.paddingInline}`,
      borderRadius: tokens.radiusThumb,
      border: `1px solid ${tokens.border}`,
      color: tokens.textTertiary,
    }}
  >
    项目
  </span>
);

const SEARCH_INPUT_STYLE: CSSProperties = {
  width: '100%',
  height: layout.controlHeight.sm,
  paddingLeft: layout.titleBar.search.clearanceLeft,
  paddingRight: layout.titleBar.search.clearanceRight,
  borderRadius: tokens.radiusControl,
  border: `1px solid ${tokens.border}`,
  background: tokens.bgInput,
  color: tokens.textPrimary,
  fontSize: tokens.text.body.size,
  lineHeight: tokens.text.body.leading,
  outline: 'none',
};

interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

function ProjectSearch(): React.ReactElement {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  const [items, setItems] = useState<ProjectOption[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const lower = keyword.toLowerCase();
    void projectApi
      .list()
      .then((all) => {
        setItems(all.filter((p) => p.name.toLowerCase().includes(lower)).slice(0, 6));
      })
      .catch(() => {
        setItems([]);
      });
  }, [keyword, open]);

  return (
    <div
      style={{ position: 'relative', width: '100%', WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      <input
        value={keyword}
        placeholder="搜索剧集或成品…"
        onChange={(event) => {
          setKeyword(event.target.value);
        }}
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={() => {
          window.setTimeout(() => {
            setOpen(false);
          }, 150);
        }}
        style={SEARCH_INPUT_STYLE}
      />
      {SEARCH_ICON}
      {SEARCH_BADGE}
      {open && items.length > 0 && (
        <SearchResults
          items={items}
          onPick={(picked) => {
            rememberDrama(picked.id, picked.name);
            void navigate(dramaEntryPath(picked.id));
          }}
        />
      )}
    </div>
  );
}

function SearchResults({
  items,
  onPick,
}: {
  items: readonly ProjectOption[];
  onPick: (item: ProjectOption) => void;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        top: layout.titleBar.search.resultsOffset,
        left: 0,
        right: 0,
        zIndex: 30,
        borderRadius: tokens.radiusControl,
        border: `1px solid ${tokens.border}`,
        background: tokens.bgElevated,
        boxShadow: tokens.shadowPop,
        overflow: 'hidden',
      }}
    >
      {items.map((item) => (
        <div
          key={item.id}
          onMouseDown={() => {
            onPick(item);
          }}
          style={{
            padding: `${tokens.spaceSm} ${tokens.spaceMd}`,
            fontSize: tokens.text.body.size,
            lineHeight: tokens.text.body.leading,
            color: tokens.textSecondary,
            cursor: 'pointer',
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = hoverBg;
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
          }}
        >
          {item.name}
        </div>
      ))}
    </div>
  );
}

function WindowButtons() {
  const make = (
    label: React.ReactNode,
    action: 'minimize' | 'maximize-toggle' | 'close',
    hover: string,
  ) => (
    <button
      type="button"
      onClick={() => {
        void windowControl(action);
      }}
      style={{
        width: layout.titleBar.windowButton.width,
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        color: tokens.textSecondary,
        fontSize: tokens.glyph.icon,
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
      } as CSSProperties}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = hover;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {make(<MinusOutlined />, 'minimize', hoverBg)}
      {make(<BorderOutlined style={{ fontSize: tokens.glyph.icon }} />, 'maximize-toggle', hoverBg)}
      {make(<CloseOutlined />, 'close', tokens.closeHot)}
    </div>
  );
}
