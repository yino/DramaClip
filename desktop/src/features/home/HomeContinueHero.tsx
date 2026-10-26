/** 有项目时的首页主卡：把最近一部剧放在首屏，封面条可直接继续。 */
import {
  ArrowRightOutlined,
  FolderAddOutlined,
  PlayCircleFilled,
} from '@ant-design/icons';
import { Button } from 'antd';
import type { ReactElement } from 'react';
import type { JobInfo, Project, WorkItem } from '@dramaclip/protocol';
import { mediaUrl } from '../../services/client';
import { rememberDrama, readLastDrama } from '../../stores/lastDrama';
import { layout, tokens } from '../../styles/theme';
import { buildMatrixRows, sortRows, type MatrixRow } from './matrixRows';
import type { WorkbenchStats } from './stats';

export function ContinueHero({
  projects,
  works,
  jobs,
  serverTimeMs,
  stats,
  onCreate,
  onNavigate,
}: {
  projects: readonly Project[];
  works: readonly WorkItem[];
  jobs: readonly JobInfo[];
  serverTimeMs: number;
  stats: WorkbenchStats;
  onCreate: () => void;
  onNavigate: (path: string) => void;
}): ReactElement {
  const rows = sortRows(
    buildMatrixRows(projects, works, jobs, serverTimeMs),
    readLastDrama()?.id ?? null,
  );
  const featured = rows[0];
  if (featured === undefined) throw new Error('有项目却没有可展示的剧');

  return (
    <section
      className="home-empty-card"
      style={{
        minWidth: 0,
        padding: tokens.space3xl,
        overflow: 'hidden',
        background: `${tokens.homeHalo}, ${tokens.homeCardSheen}`,
        border: `1px solid ${tokens.borderSecondary}`,
        borderRadius: tokens.radiusCard,
        boxShadow: tokens.shadowCard,
      }}
    >
      <ContinueCopy featured={featured} stats={stats} onCreate={onCreate} onNavigate={onNavigate} />
      <ProjectReel rows={rows} onNavigate={onNavigate} />
    </section>
  );
}

function ContinueCopy({
  featured,
  stats,
  onCreate,
  onNavigate,
}: {
  featured: MatrixRow;
  stats: WorkbenchStats;
  onCreate: () => void;
  onNavigate: (path: string) => void;
}): ReactElement {
  return (
    <div style={{ minWidth: 0, maxWidth: 650 }}>
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
            background: tokens.colorSuccess,
          }}
        />
        继续创作
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
        接着上一部，
        <br />
        把故事剪成能发的片子
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
        {`${featured.project.name} · ${String(featured.project.episode_count)} 集素材已就位，从上次停下的位置继续。`}
      </p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spaceMd,
          flexWrap: 'wrap',
          marginTop: tokens.space2xl,
        }}
      >
        <Button
          type="primary"
          size="large"
          icon={<PlayCircleFilled />}
          onClick={() => {
            rememberDrama(featured.project.id, featured.project.name);
            onNavigate(featured.cont.route);
          }}
        >
          {featured.cont.label}
        </Button>
        <Button size="large" icon={<FolderAddOutlined />} onClick={onCreate}>
          新增项目
        </Button>
      </div>
      <ContinueStats stats={stats} />
    </div>
  );
}

function ContinueStats({ stats }: { stats: WorkbenchStats }): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spaceLg,
        flexWrap: 'wrap',
        marginTop: tokens.spaceXl,
        fontSize: tokens.text.meta.size,
        lineHeight: tokens.text.meta.leading,
        color: tokens.textTertiary,
      }}
    >
      <span>{`${String(stats.dramaCount)} 个项目`}</span>
      <span>{`${stats.runningValue} 项在跑`}</span>
      <span>{`${String(stats.workCount)}${stats.workCountOverflow ? '+' : ''} 部成品`}</span>
      <span style={{ marginLeft: 'auto' }}>{greetingLine()}</span>
    </div>
  );
}

function ProjectReel({
  rows,
  onNavigate,
}: {
  rows: readonly MatrixRow[];
  onNavigate: (path: string) => void;
}): ReactElement {
  const fallbackTitles = ['素材', '分析', '成片'];
  const fallbackBackgrounds = [tokens.homePosterDim, tokens.homePosterFallback, tokens.homePosterWarm];
  return (
    <div className="home-film-strip" style={{ gap: tokens.spaceSm, marginLeft: tokens.spaceXl }}>
      {Array.from({ length: 3 }, (_, index) => {
        const row = rows[index] ?? null;
        return (
          <button
            key={row?.project.id ?? `fallback-${String(index)}`}
            type="button"
            aria-label={row === null ? undefined : `继续 ${row.project.name}`}
            disabled={row === null}
            onClick={() => {
              if (row === null) return;
              rememberDrama(row.project.id, row.project.name);
              onNavigate(row.cont.route);
            }}
            style={{
              position: 'relative',
              width: layout.home.heroPreviewWidth,
              height: layout.home.heroPreviewHeight,
              padding: 0,
              overflow: 'hidden',
              borderRadius: tokens.radiusControl,
              border: `1px solid ${tokens.homeHairline}`,
              background: row?.project.cover_path ? tokens.posterBase : fallbackBackgrounds[index],
              boxShadow: tokens.shadowCard,
              cursor: row === null ? 'default' : 'pointer',
              transform: index === 1 ? 'translateY(-8px)' : undefined,
            }}
          >
            {row?.project.cover_path ? (
              <img
                src={mediaUrl(row.project.cover_path)}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <PlayCircleFilled
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  fontSize: tokens.glyph.poster,
                  color: tokens.textPrimary,
                }}
              />
            )}
            <span style={{ position: 'absolute', inset: 0, background: tokens.homePreviewScrim }} />
            <span
              style={{
                position: 'absolute',
                left: tokens.spaceSm,
                right: tokens.spaceSm,
                bottom: tokens.spaceSm,
                display: 'block',
                textAlign: 'left',
                fontSize: tokens.text.badge.size,
                lineHeight: tokens.text.badge.leading,
                fontWeight: tokens.text.badge.weightActive,
                color: tokens.textPrimary,
              }}
            >
              {row === null ? fallbackTitles[index] : `${String(row.project.episode_count)} 集`}
              {row !== null && (
                <ArrowRightOutlined
                  style={{ display: 'block', marginTop: tokens.spaceXs, fontSize: tokens.glyph.icon }}
                />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function greetingLine(): string {
  const now = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()] ?? '';
  const hour = now.getHours();
  const greeting =
    hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  return `${greeting} · ${String(now.getMonth() + 1)}月${String(now.getDate())}日 星期${week}`;
}
