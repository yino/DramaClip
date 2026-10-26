/** 出片记录：本项目历次导出的终态列表，点开进成片详情。 */
import { Empty, Tag, Tooltip } from 'antd';
import { PageSection } from '../../components/layout/PageKit';
import { useNavigate } from 'react-router-dom';
import type { ExportJob } from '@dramaclip/protocol';
import { modeLabel } from '../../components/modeMeta';
import { tokens } from '../../styles/theme';

export function ExportsCard({ exports }: { exports: ExportJob[] | null }) {
  return (
    <PageSection title="出片记录" dense>
      {exports === null ? null : exports.length === 0 ? (
        <Empty description="还没有出片记录——选好方案点「出片所选」" styles={{ image: { height: 60 } }} />
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spaceSm }}>
          {exports.map((job) => (
            <ExportRow key={job.id} job={job} />
          ))}
        </div>
      )}
    </PageSection>
  );
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** 出片列表的本地时间：已完成取完成时间，进行中/失败回退创建时间（标注「开始」）。 */
function formatExportWhen(job: ExportJob): { text: string; title: string } {
  const ms = job.completed_at ?? job.created_at;
  const date = new Date(ms);
  const short = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const full = `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  if (job.completed_at === undefined) return { text: `开始 ${short}`, title: `创建于 ${full}` };
  return { text: short, title: `完成于 ${full}` };
}

function ExportRow({ job }: { job: ExportJob }) {
  const navigate = useNavigate();
  const when = formatExportWhen(job);
  const label = job.status === 'completed' ? '完成' : job.status === 'failed' ? '失败' : '进行中';
  const color = job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'processing';
  return (
    <div
      onClick={() => {
        void navigate(`/works/${job.id}`);
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spaceMd,
        padding: `${tokens.spaceSm} 0`,
        borderBottom: `1px solid ${tokens.borderSecondary}`,
        fontSize: tokens.text.body.size,
        lineHeight: tokens.text.body.leading,
        cursor: 'pointer',
      }}
    >
      <Tag color={color}>{label}</Tag>
      {job.status === 'failed' && job.error !== undefined ? (
        <Tooltip title={job.error}>
          <span style={{ color: tokens.colorWarning, fontSize: tokens.text.badge.size, lineHeight: tokens.text.badge.leading, marginLeft: tokens.spaceSm }}>原因</span>
        </Tooltip>
      ) : null}
      <span style={{ color: tokens.textPrimary }}>{modeLabel(job.narration_mode)}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spaceMd, fontFamily: tokens.fontFamilyMono, fontSize: tokens.text.meta.size, lineHeight: tokens.text.meta.leading }}>
        <span title={when.title} style={{ color: tokens.textSecondary }}>
          {when.text}
        </span>
        <span style={{ color: tokens.textTertiary }}>{job.duration_s !== undefined ? `${String(Math.round(job.duration_s))}s` : ''}</span>
      </span>
    </div>
  );
}
