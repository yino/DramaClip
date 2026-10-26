/**
 * 语音识别 ASR tab：当前生效卡（本地模型 / 云端配置混排切换）→「本地模型 | 云端配置」分段资产库。
 * 云端生效时参数换形（计费 / 上次连通替换运行设备 / 磁盘实占），判据永远是设置与配置表，前端不写死。
 *
 * 激活托管态（activation.available）是另一条渲染路径：地址/密钥/自由模型输入一律不挂载，
 * 只保留「云端识别由账号提供」+ 两个协议别名 + 积分余额；本地引擎始终可启停。
 */
import { Alert, Button, Select } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import type { DefaultOptionType } from 'antd/es/select';
import type { CSSProperties, ReactElement } from 'react';
import type { ActivationSnapshot, AsrCredits, EngineConfig, ModelInfo } from '@dramaclip/protocol';
import { tokens } from '../../styles/theme';
import { PageSection } from '../../components/layout/PageKit';
import type { DomainTabProps } from './EnginesPage';
import type { Reports } from './assetState';
import { localDomainModels } from './assetState';
import {
  activateSettings,
  activeAsset,
  activeStateNote,
  assetState,
  canActivate,
  externalAssets,
  formatBytes,
  reportFor,
} from './assetState';
import { type ActiveCardProps, ActiveEngineCard } from './ActiveEngineCard';
import { LocalRuntimeSlot } from './LocalRuntimeSlot';
import { AssetLibrary } from './AssetLibrary';
import {
  type ManagedAsrActivation,
  CloudConfigsPane,
  CloudSegment,
  CloudTestButton,
  MixedEnginePicker,
  activeCloudConfig,
} from './CloudDomainUI';
import { ActivationInfoRow, ActivationStatusTag } from '../activation/ActivationBits';
import { formatTime, LOCAL_UNAFFECTED, suspensionText } from '../activation/activationView';
import * as clientBridge from '../../services/client';
import { SettingSelect } from './SettingSelect';
import { useDownloadProgress } from './useDownloadProgress';
import { type EngineConfigActions, useEngineConfigs } from './useEngineConfigs';

// 旧壳/单测可能只 mock 了部分客户端：缺导出时按「未接线」降级，不抛错。
function asrBridge(): typeof clientBridge.asrApi | undefined {
  return 'asrApi' in clientBridge ? clientBridge.asrApi : undefined;
}

function eventBridge(): typeof clientBridge.onServiceEvent | undefined {
  return 'onServiceEvent' in clientBridge ? clientBridge.onServiceEvent : undefined;
}

const PARAMS: readonly { key: string; label: string; options: DefaultOptionType[] }[] = [
  {
    key: 'asr.device',
    label: '运行设备',
    options: [
      { label: '自动（检测 GPU）', value: 'auto' },
      { label: 'CPU', value: 'cpu' },
      { label: 'CUDA（NVIDIA）', value: 'cuda' },
    ],
  },
  {
    key: 'asr.language',
    label: '识别语言',
    options: [
      { label: '中文', value: 'zh' },
      { label: '英文', value: 'en' },
    ],
  },
  {
    key: 'asr.diarization',
    label: '说话人分离',
    options: [
      { label: '自动（按引擎能力）', value: 'auto' },
      { label: '强制开启', value: 'true' },
      { label: '关闭', value: 'false' },
    ],
  },
];

const CLOUD_NOTE =
  '云端转写按「配置」接入：可添加多个服务商与模型，同一时刻启用一条，切换即改生效引擎。'
  + '密钥只存本机数据库、界面脱敏显示，分析日志与导出物不含密钥；未测通的配置可以保存，但启用前建议先测连接。';

/** 网关只认这两个别名（design D1）；页面写回也只碰 asr.model，不碰地址与密钥。 */
const ASR_ALIASES: readonly { label: string; value: string }[] = [
  { label: 'fun-asr-flash（默认 · 更快）', value: 'fun-asr-flash' },
  { label: 'qwen-audio-3.1-asr-flash（含说话人分离）', value: 'qwen-audio-3.1-asr-flash' },
];
const ASR_ALIAS_VALUES: readonly string[] = ASR_ALIASES.map((alias) => alias.value);

const MANAGED_ASR_TITLE = '云端识别（账号托管）';
const MANAGED_ASR_INTRO =
  '云端识别由账号提供：模型按别名由激活网关路由，地址、密钥与模型名不再手填，也不在设置里展示。';

const MUTED: CSSProperties = {
  fontSize: tokens.text.meta.size,
  lineHeight: tokens.text.meta.leading,
  color: tokens.textTertiary,
};

interface AsrCreditsState {
  readonly credits: AsrCredits | null;
  readonly loading: boolean;
  readonly error: string;
  readonly reload: () => void;
}

function creditErrorText(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : '积分暂不可用';
}

/** 积分余额：进页面读一次、激活状态变化再读、识别完成（progress 100%）再读。 */
function useAsrCredits(enabled: boolean, session: string): AsrCreditsState {
  const [credits, setCredits] = useState<AsrCredits | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const reload = useCallback((): void => {
    if (!enabled) return;
    const call = asrBridge()?.credits;
    if (typeof call !== 'function') {
      setError('积分查询未接线：请重启应用后再试');
      return;
    }
    setLoading(true);
    call()
      .then((next) => {
        setCredits(next);
        setError(next.available ? '' : (next.reason ?? '积分暂不可用'));
      })
      .catch((cause: unknown) => {
        setCredits(null);
        setError(creditErrorText(cause));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [enabled]);
  useEffect(() => {
    reload();
  }, [reload, session]);
  useEffect(() => {
    if (!enabled) return undefined;
    const subscribe = eventBridge();
    if (typeof subscribe !== 'function') return undefined;
    return subscribe((event) => {
      if (event.type !== 'notification' || event.method !== 'progress.update') return;
      if (Number(event.params.percent ?? 0) >= 100) reload();
    });
  }, [enabled, reload]);
  return { credits, loading, error, reload };
}

export function AsrTab(props: DomainTabProps): ReactElement {
  const { models, settings, onSave, onChanged, activation } = props;
  const cloud = useEngineConfigs('asr_cloud', onChanged);
  const [pane, setPane] = useState<'local' | 'cloud'>('local');
  const activeCloud = activeCloudConfig(cloud.configs);
  const domainModels = localDomainModels(models, 'asr');
  const active = activeAsset(models, 'asr', settings);
  const managed = activation?.available === true;
  const snapshot = managed ? (activation.snapshot ?? null) : null;
  const session = snapshot === null ? '' : `${snapshot.status}:${snapshot.lastVerifiedAt}`;
  const credits = useAsrCredits(
    managed && snapshot !== null && (snapshot.status === 'active' || snapshot.status === 'suspended'),
    session,
  );
  const segment = <CloudSegment value={pane} onChange={setPane} />;
  const pickCloud = (config: EngineConfig): void => {
    cloud.enable(config);
  };
  const pickLocal = (model: ModelInfo): void => {
    cloud
      .enableLocal()
      .catch(() => undefined)
      .finally(() => {
        onSave(activateSettings(model));
      });
  };
  const engine = settings['asr.engine'] ?? '';
  const localActive = engine === 'cloud_gateway' ? undefined : active;

  if (managed) {
    return (
      <ManagedAsrLayout
        tab={props}
        activation={activation}
        snapshot={snapshot}
        credits={credits}
        engine={engine}
        localActive={localActive}
        domainModels={domainModels}
        onPickLocal={pickLocal}
      />
    );
  }

  return (
    <LegacyAsrLayout
      tab={props}
      cloud={cloud}
      pane={pane}
      segment={segment}
      activeCloud={activeCloud}
      active={active}
      domainModels={domainModels}
      onPickLocal={pickLocal}
      onPickCloud={pickCloud}
    />
  );
}


interface LegacyAsrLayoutProps {
  readonly tab: DomainTabProps;
  readonly cloud: EngineConfigActions;
  readonly pane: 'local' | 'cloud';
  readonly segment: ReactElement;
  readonly activeCloud: EngineConfig | undefined;
  readonly active: ModelInfo | undefined;
  readonly domainModels: readonly ModelInfo[];
  readonly onPickLocal: (model: ModelInfo) => void;
  readonly onPickCloud: (config: EngineConfig) => void;
}

/** 旧云端配置路径（客户端自带 Key / 本地引擎切换）：activationApi 未接线或旧部署时使用。 */
function LegacyAsrLayout({
  tab,
  cloud,
  pane,
  segment,
  activeCloud,
  active,
  domainModels,
  onPickLocal,
  onPickCloud,
}: LegacyAsrLayoutProps): ReactElement {
  const { imported, importError, settings, reports, selftests, machine, onSave, onChanged, onVerify, onForget, onImport } = tab;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceLg }}>
      <LocalRuntimeSlot scope="asr" />
      {activeCloud !== undefined ? (
        <ActiveEngineCard
          domain="语音识别 ASR"
          title={activeCloud.name}
          state={null}
          hint={`云端转写 · 按量计费 · 模型 ${activeCloud.model}`}
          picker={
            <MixedEnginePicker
              width={210}
              localValue={active?.model_id ?? ''}
              localOptions={domainModels.map((model) => ({
                label: model.name,
                value: model.model_id,
                disabled: !canActivate(model, reportFor(reports, model.model_id)),
              }))}
              configs={cloud.configs}
              onPickLocal={(value) => {
                const picked = domainModels.find((model) => model.model_id === value);
                if (picked !== undefined) onPickLocal(picked);
              }}
              onPickCloud={onPickCloud}
            />
          }
          actions={<CloudTestButton config={activeCloud} domain="asr_cloud" />}
          props={[
            ...paramProps(settings, onSave, ['asr.language', 'asr.diarization']),
            { label: '接口地址', value: activeCloud.base_url === '' ? '服务商标准端点' : activeCloud.base_url },
            { label: '密钥', value: activeCloud.api_key_masked },
            { label: '生效时机', value: '保存后下次分析' },
          ]}
          footnote="云端转写免下载免显存，按音频时长计费（转写为异步任务，耗时与音频时长同量级）；切回本地模型用上方下拉选「本地模型」分组。"
        />
      ) : (
        <ActiveCard
          models={domainModels}
          active={active}
          settings={settings}
          reports={reports}
          selftests={selftests}
          onSave={onSave}
          onVerify={onVerify}
          configs={cloud.configs}
          onPickCloud={onPickCloud}
        />
      )}
      {pane === 'local' ? (
        <AssetLibrary
          models={domainModels}
          externals={externalAssets(imported, 'asr')}
          importError={importError}
          reports={reports}
          selftests={selftests}
          specs={machine}
          activeModelId={active?.model_id}
          onActivate={onPickLocal}
          onChanged={onChanged}
          onVerify={onVerify}
          onForget={onForget}
          onImport={onImport}
          segment={segment}
        />
      ) : (
        <PageSection title="云端配置" extra={segment}>
          <CloudConfigsPane domain="asr_cloud" actions={cloud} onChanged={onChanged} note={CLOUD_NOTE} />
        </PageSection>
      )}
    </div>
  );
}

interface ManagedAsrLayoutProps {
  readonly tab: DomainTabProps;
  readonly activation: ManagedAsrActivation;
  readonly snapshot: ActivationSnapshot | null;
  readonly credits: AsrCreditsState;
  readonly engine: string;
  readonly localActive: ModelInfo | undefined;
  readonly domainModels: readonly ModelInfo[];
  readonly onPickLocal: (model: ModelInfo) => void;
}

/** 托管态主体：只读别名与积分；地址/密钥/自由模型输入一律不挂载（旧云端配置路径不进入这里）。 */
function ManagedAsrLayout({
  tab,
  activation,
  snapshot,
  credits,
  engine,
  localActive,
  domainModels,
  onPickLocal,
}: ManagedAsrLayoutProps): ReactElement {
  const { imported, importError, settings, reports, selftests, machine, onSave, onChanged, onVerify, onForget, onImport } = tab;

  return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceLg }}>
        <LocalRuntimeSlot scope="asr" />
        {snapshot === null ? (
          <PageSection title={MANAGED_ASR_TITLE}>
            <div style={MUTED}>{activation.error === '' ? '正在读取激活状态…' : activation.error}</div>
          </PageSection>
        ) : (
          <ManagedAsrPanel
            snapshot={snapshot}
            model={settings['asr.model'] ?? ''}
            credits={credits}
            busy={activation.busy}
            error={activation.error}
            onPickModel={(alias) => {
              onSave({ 'asr.model': alias });
            }}
            onRefresh={credits.reload}
            onRecheck={activation.recheck}
          />
        )}
        {engine !== 'cloud_gateway' && (
          <ActiveCard
            models={domainModels}
            active={localActive}
            settings={settings}
            reports={reports}
            selftests={selftests}
            onSave={onSave}
            onVerify={onVerify}
            configs={[]}
            onPickCloud={() => undefined}
            managed
          />
        )}
        <AssetLibrary
          models={domainModels}
          externals={externalAssets(imported, 'asr')}
          importError={importError}
          reports={reports}
          selftests={selftests}
          specs={machine}
          activeModelId={localActive?.model_id}
          onActivate={onPickLocal}
          onChanged={onChanged}
          onVerify={onVerify}
          onForget={onForget}
          onImport={onImport}
        />
        {engine === 'cloud_gateway' && (
          <PageSection title="本地引擎">
            <div style={MUTED}>
              切回本地不消耗积分：在下方资产库选一个本地模型「选为生效」即可；本地转写、字幕、剪辑与导出不受影响。
            </div>
          </PageSection>
        )}
      </div>
  );
}

function formatCredits(value: number): string {
  return value.toFixed(2);
}

/** 托管识别面板：别名选择 + 积分余额 + 状态提示；绝不渲染地址/密钥/自由模型输入。 */
function ManagedAsrPanel({
  snapshot,
  model,
  credits,
  busy,
  error,
  onPickModel,
  onRefresh,
  onRecheck,
}: {
  snapshot: ActivationSnapshot;
  model: string;
  credits: AsrCreditsState;
  busy: boolean;
  error: string;
  onPickModel: (alias: string) => void;
  onRefresh: () => void;
  onRecheck: () => void;
}): ReactElement {
  const status = snapshot.status;
  const alias = ASR_ALIAS_VALUES.includes(model) ? model : 'fun-asr-flash';
  const diarized = alias.startsWith('qwen-audio');
  return (
    <PageSection title={MANAGED_ASR_TITLE} extra={<ActivationStatusTag status={status} />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spaceMd }}>
        <div style={MUTED}>{MANAGED_ASR_INTRO}</div>
        {status === 'inactive' && (
          <Alert
            type="warning"
            showIcon
            title="云端识别未激活"
            description="云端识别由账号提供，激活后才能使用；本地引擎仍可正常启停。"
          />
        )}
        {status === 'verifying' && <Alert type="info" showIcon title="正在校验激活状态…" />}
        {status === 'suspended' && (
          <Alert
            type="warning"
            showIcon
            title={`已暂停：${suspensionText(snapshot)}`}
            description={`云端识别暂不可用；本地引擎仍可启用。${LOCAL_UNAFFECTED}`}
            action={
              <Button size="small" loading={busy} onClick={onRecheck}>
                重新校验
              </Button>
            }
          />
        )}
        {(status === 'active' || status === 'suspended') && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spaceMd }}>
              <span style={{ fontSize: tokens.text.meta.size, color: tokens.textSecondary }}>识别模型</span>
              <Select
                style={{ width: 360 }}
                value={alias}
                disabled={status === 'suspended'}
                options={ASR_ALIASES.map((item) => ({ label: item.label, value: item.value }))}
                onChange={(value: string) => {
                  onPickModel(value);
                }}
              />
            </div>
            <div style={MUTED}>
              {diarized
                ? '当前别名支持说话人分离：是否分离仍按「说话人分离」设置生效。'
                : '当前别名不做说话人分离：分段保留时间顺序，角色留空。'}
            </div>
          </>
        )}
        {(status === 'active' || status === 'suspended') && (
          <div
            style={{
              border: `1px solid ${tokens.borderSecondary}`,
              borderRadius: tokens.radiusControl,
              padding: `${tokens.spaceMd} ${tokens.spaceLg}`,
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.spaceSm,
              maxWidth: 720,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spaceMd }}>
              <span style={{ fontWeight: 600, color: tokens.textPrimary }}>识别积分</span>
              <Button size="small" loading={credits.loading} onClick={onRefresh}>
                刷新积分
              </Button>
            </div>
            {credits.credits?.available === true ? (
              <>
                <ActivationInfoRow label="总额" value={`${formatCredits(credits.credits.limit)} 分钟`} />
                <ActivationInfoRow label="已用" value={`${formatCredits(credits.credits.used)} 分钟`} />
                <ActivationInfoRow label="剩余" value={`${formatCredits(credits.credits.remaining)} 分钟`} />
                <ActivationInfoRow label="更新时间" value={formatTime(credits.credits.updated_at)} />
                <div style={MUTED}>1 积分 = 1 分钟音频；识别完成后自动刷新。</div>
              </>
            ) : credits.loading && credits.credits === null ? (
              <div style={MUTED}>读取积分中…</div>
            ) : (
              <div style={{ ...MUTED, color: tokens.colorWarning }}>
                积分暂不可用：{credits.error === '' ? '稍后重试' : credits.error}
              </div>
            )}
          </div>
        )}
        {status === 'active' && (
          <Alert type="success" showIcon title="托管配置生效中：音频经激活网关转写，网关不保存音频。" />
        )}
        {error !== '' && <Alert type="error" showIcon title={error} />}
      </div>
    </PageSection>
  );
}

function ActiveCard({
  models,
  active,
  settings,
  reports,
  selftests,
  onSave,
  onVerify,
  configs,
  onPickCloud,
  managed = false,
}: {
  models: readonly ModelInfo[];
  active: ModelInfo | undefined;
  settings: DomainTabProps['settings'];
  reports: Reports;
  selftests: DomainTabProps['selftests'];
  onSave: DomainTabProps['onSave'];
  onVerify: DomainTabProps['onVerify'];
  configs: readonly EngineConfig[];
  onPickCloud: (config: EngineConfig) => void;
  managed?: boolean;
}): ReactElement {
  const report = active === undefined ? undefined : reportFor(reports, active.model_id);
  const state = active === undefined ? null : assetState(active, report, selftests?.[active.model_id]);
  const picker = managed ? (
    <Select
      size="small"
      style={{ width: 210 }}
      value={active?.model_id}
      placeholder="选择本地模型"
      options={models.map((model) => ({
        label: model.name,
        value: model.model_id,
        disabled: !canActivate(model, reportFor(reports, model.model_id)),
      }))}
      onChange={(value: string) => {
        const picked = models.find((model) => model.model_id === value);
        if (picked !== undefined) onSave(activateSettings(picked));
      }}
    />
  ) : (
    <MixedEnginePicker
      width={210}
      localValue={active?.model_id}
      localOptions={models.map((model) => ({
        label: model.name,
        value: model.model_id,
        disabled: !canActivate(model, reportFor(reports, model.model_id)),
      }))}
      configs={configs}
      onPickLocal={(value) => {
        const picked = models.find((model) => model.model_id === value);
        if (picked !== undefined) onSave(activateSettings(picked));
      }}
      onPickCloud={onPickCloud}
    />
  );
  const card: ActiveCardProps = {
    domain: '语音识别 ASR',
    title: active?.name ?? '未选择模型',
    state,
    hint: managed
      ? '本地引擎与云端识别互斥：在下方资产库「选为生效」即切回本地，不消耗积分。'
      : '设置里没有可用的识别模型，去下方资产库选一个；或切「云端配置」接云端转写',
    stateNote: state === null ? undefined : activeStateNote(state, report),
    progress: useDownloadProgress(active),
    picker,
    actions:
      active === undefined ? undefined : (
        <Button
          size="small"
          onClick={() => {
            onVerify(active.model_id);
          }}
        >
          校验资产
        </Button>
      ),
    props: [
      ...paramProps(settings, onSave, ['asr.device', 'asr.language', 'asr.diarization']),
      { label: '磁盘实占', value: active === undefined ? '—' : active.size_bytes === undefined || active.size_bytes === null ? '统计中…' : formatBytes(active.size_bytes) },
      { label: '生效时机', value: '保存后下次分析' },
    ],
    footnote: '「自动」＝检测到可用 GPU 即启用，否则回退 CPU；显卡与运行库的实际情况见「环境」段的转写加速卡。',
  };
  return <ActiveEngineCard {...card} />;
}

function paramProps(
  settings: DomainTabProps['settings'],
  onSave: DomainTabProps['onSave'],
  keys: readonly string[],
): ActiveCardProps['props'] {
  return PARAMS.filter((param) => keys.includes(param.key)).map((param) => ({
    label: param.label,
    value: (
      <SettingSelect
        value={settings[param.key] ?? ''}
        options={param.options}
        onChange={(value: string) => {
          onSave({ [param.key]: value });
        }}
      />
    ),
  }));
}
