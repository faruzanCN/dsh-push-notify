import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const inject = ['webServer', 'connection'];

const DEFAULT_CONFIG = {
  titlePrefix: '',
  webUrl: 'http://127.0.0.1:3080',
  notifyOnTurnEnd: true,
  notifyOnApproval: true,
  notifyOnQuestion: true,
  notifyOnError: true,
  bark: {
    enabled: true,
    serverUrl: 'https://api.day.app',
    deviceKey: '',
    sound: 'system',
    group: 'DeepSeek Harness',
  },
  ntfy: {
    enabled: false,
    serverUrl: 'https://ntfy.sh',
    topic: '',
    token: '',
    priority: 'default',
  },
};

function sendJson(res, status, payload) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 64) {
        reject(new Error('payload-too-large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function normalizePrefix(prefix) {
  if (!prefix || typeof prefix !== 'string') return '';
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const limited = trimmed.slice(0, 12);
  return `[${limited}] `;
}

export function apply(ctx, config) {
  // 智能寻找稳妥的配置存储目录，优先写入 DSH Profile 目录，降级回退到用户主目录
  const candidateDirs = [
    process.env.DSH_PROFILE_DIR,
    join(homedir(), '.dsh', 'profiles', 'web'),
    join(homedir(), '.dsh'),
    homedir(),
    process.cwd(),
  ].filter(Boolean);

  const getReadPaths = () => {
    const paths = [];
    for (const dir of candidateDirs) {
      paths.push(join(dir, 'push-notify-config.json'));
      paths.push(join(dir, 'bark-config.json'));
    }
    return [...new Set(paths)];
  };

  const getPrimaryConfigPath = () => {
    const primaryDir = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web');
    return join(primaryDir, 'push-notify-config.json');
  };

  const loadConfig = () => {
    const tryPaths = getReadPaths();
    for (const p of tryPaths) {
      try {
        if (existsSync(p)) {
          const fileData = JSON.parse(readFileSync(p, 'utf8'));
          if (p.endsWith('bark-config.json')) {
            // 平滑兼容旧版 bark-config.json
            return {
              ...DEFAULT_CONFIG,
              ...config,
              titlePrefix: fileData.titlePrefix || '',
              webUrl: fileData.webUrl || DEFAULT_CONFIG.webUrl,
              notifyOnTurnEnd: fileData.notifyOnTurnEnd ?? true,
              notifyOnApproval: fileData.notifyOnApproval ?? true,
              notifyOnQuestion: fileData.notifyOnQuestion ?? true,
              notifyOnError: fileData.notifyOnError ?? true,
              bark: {
                ...DEFAULT_CONFIG.bark,
                enabled: !!fileData.deviceKey,
                serverUrl: fileData.serverUrl || DEFAULT_CONFIG.bark.serverUrl,
                deviceKey: fileData.deviceKey || '',
                sound: fileData.sound || 'system',
                group: fileData.group || 'DeepSeek Harness',
              },
            };
          }

          return {
            ...DEFAULT_CONFIG,
            ...config,
            ...fileData,
            bark: { ...DEFAULT_CONFIG.bark, ...(config?.bark || {}), ...(fileData?.bark || {}) },
            ntfy: { ...DEFAULT_CONFIG.ntfy, ...(config?.ntfy || {}), ...(fileData?.ntfy || {}) },
          };
        }
      } catch (e) {
        ctx.logger?.warn?.(`[push-notify] 读取配置文件 ${p} 失败:`, e?.message);
      }
    }
    return { ...DEFAULT_CONFIG, ...config };
  };

  let activeConfig = loadConfig();

  const saveConfig = (newCfg) => {
    activeConfig = {
      ...activeConfig,
      ...newCfg,
      titlePrefix: (typeof newCfg.titlePrefix === 'string' ? newCfg.titlePrefix.slice(0, 12) : (activeConfig.titlePrefix || '')),
      bark: { ...(activeConfig.bark || DEFAULT_CONFIG.bark), ...(newCfg.bark || {}) },
      ntfy: { ...(activeConfig.ntfy || DEFAULT_CONFIG.ntfy), ...(newCfg.ntfy || {}) },
    };

    const targetPaths = [
      getPrimaryConfigPath(),
      join(homedir(), 'push-notify-config.json'),
    ];

    let saved = false;
    for (const p of targetPaths) {
      try {
        writeFileSync(p, JSON.stringify(activeConfig, null, 2), 'utf8');
        saved = true;
      } catch (e) {
        ctx.logger?.warn?.(`[push-notify] 保存配置文件到 ${p} 失败:`, e?.message);
      }
    }
    return saved;
  };

  // Bark 推送执行器
  const sendBark = async (title, body, extraUrl) => {
    const cfg = activeConfig.bark || {};
    const deviceKey = cfg.deviceKey?.trim();
    if (!deviceKey) {
      return { ok: false, message: 'Bark 未配置 Device Key' };
    }

    const serverUrl = (cfg.serverUrl || 'https://api.day.app').trim().replace(/\/+$/, '');
    const pushEndpoint = `${serverUrl}/push`;
    const targetUrl = extraUrl || activeConfig.webUrl || undefined;
    const soundValue = (!cfg.sound || cfg.sound === 'system') ? undefined : cfg.sound;

    const payload = {
      device_key: deviceKey,
      title: title || 'DeepSeek Harness',
      body: body || '',
      group: cfg.group || 'DeepSeek Harness',
      ...(soundValue ? { sound: soundValue } : {}),
      ...(targetUrl ? { url: targetUrl } : {}),
    };

    try {
      const response = await fetch(pushEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return { ok: false, message: `Bark HTTP ${response.status}: ${errorText}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: `Bark 异常: ${err?.message || err}` };
    }
  };

  // ntfy 推送执行器 (改用安全标准的 JSON Payload 规范，避免被雷池 WAF 等反向代理拦截)
  const sendNtfy = async (title, body, extraUrl, priority, tags) => {
    const cfg = activeConfig.ntfy || {};
    const topic = cfg.topic?.trim();
    if (!topic) {
      return { ok: false, message: 'ntfy 未配置 Topic' };
    }

    const serverUrl = (cfg.serverUrl || 'https://ntfy.sh').trim().replace(/\/+$/, '');
    const endpoint = `${serverUrl}/`;
    const targetUrl = extraUrl || activeConfig.webUrl || undefined;

    const payload = {
      topic,
      title: title || 'DeepSeek Harness',
      message: body || '',
      priority: priority || cfg.priority || 'default',
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(targetUrl ? { click: targetUrl } : {}),
    };

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (cfg.token?.trim()) {
      headers['Authorization'] = `Bearer ${cfg.token.trim()}`;
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return { ok: false, message: `ntfy HTTP ${response.status}: ${errorText}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: `ntfy 异常: ${err?.message || err}` };
    }
  };

  // 统一分发消息到已启用的渠道（自动附加用户自定义前缀）
  const dispatchNotification = (notification) => {
    Promise.resolve().then(async () => {
      try {
        const { title = '', body, extraUrl, priority = 'default', tags = ['bell'] } = notification;
        const prefix = normalizePrefix(activeConfig.titlePrefix);
        const finalTitle = `${prefix}${title}`;

        if (activeConfig.bark?.enabled) {
          await sendBark(finalTitle, body, extraUrl);
        }
        if (activeConfig.ntfy?.enabled) {
          await sendNtfy(finalTitle, body, extraUrl, priority, tags);
        }
      } catch (e) {
        ctx.logger?.warn?.('[push-notify] dispatch error:', e?.message || e);
      }
    });
  };

  // 注册精确 HTTP API 供前端访问
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-push-notify/config',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, { ok: true, config: activeConfig });
            return;
          }
          if (req.method === 'POST') {
            try {
              const body = await parseJsonBody(req);
              const ok = saveConfig(body);
              sendJson(res, 200, { ok, config: activeConfig });
            } catch (err) {
              sendJson(res, 400, { ok: false, error: err?.message || 'invalid payload' });
            }
            return;
          }
          res.writeHead(405, { allow: 'GET, POST' });
          res.end();
        },
      }),

      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-push-notify/test',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' });
            res.end();
            return;
          }
          try {
            const body = await parseJsonBody(req);
            const target = body.channel || 'all'; // 'bark' | 'ntfy' | 'all'
            if (body.config) {
              saveConfig(body.config);
            }

            const prefix = normalizePrefix(activeConfig.titlePrefix);
            const testTitle = `${prefix}🔔 DeepSeek Harness 推送测试`;
            const testBody = '这是一条来自 DSH 的测试通知，通道配置成功！';

            const feedback = {};
            if (target === 'bark' || target === 'all') {
              feedback.bark = await sendBark(testTitle, testBody);
            }
            if (target === 'ntfy' || target === 'all') {
              feedback.ntfy = await sendNtfy(testTitle, testBody, null, 'default', ['tada', 'bell']);
            }

            sendJson(res, 200, { ok: true, feedback });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: err?.message || 'test failed' });
          }
        },
      }),
    ];

    return () => {
      for (const d of disposers) d();
    };
  }, 'dsh-push-notify: HTTP API routes');

  // 1. 等待操作授权/批准 (Waterfall 拦截)
  ctx.on('approval/request', (req, next) => {
    if (activeConfig.notifyOnApproval) {
      const toolName = req.toolName || '工具';
      const reason = req.reason || (req.displayReason && (req.displayReason.zh || req.displayReason.en)) || '需要您授权确认';
      const title = '⚠️ DSH: 等待权限批准';
      const body = `工具 [${toolName}] 请求执行：\n${reason}`;
      dispatchNotification({ title, body, priority: 'high', tags: ['warning', 'lock'] });
    }
    return next();
  });

  // 2. 工具执行拦截：当触发 ask_user_question 时立即发送通知
  ctx.on('tools/execute', (exec, next) => {
    if (activeConfig.notifyOnQuestion && exec?.name === 'ask_user_question') {
      try {
        const questions = exec.arguments?.questions || [];
        const questionTexts = questions.map((q) => {
          const header = q.header ? `【${q.header}】` : '';
          const options = q.options ? `\n选项: ${q.options.map(o => o.label).join(' / ')}` : '';
          return `${header}${q.question}${options}`;
        }).join('\n\n');

        const title = '❓ DSH: 等待用户输入/选择';
        const body = questionTexts || 'Agent 正在等待您的确认或选择方案';
        dispatchNotification({ title, body, priority: 'high', tags: ['question', 'speech_balloon'] });
      } catch (err) {
        ctx.logger?.warn?.('[push-notify] ask_user_question notify error:', err?.message || err);
      }
    }
    return next();
  });

  // 备用兜底：针对直接触发 ctx.userQuestions.ask 的 Waterfall 监听
  ctx.on('user-questions/request', (req, next) => {
    if (activeConfig.notifyOnQuestion) {
      const questions = req.questions || [];
      const questionTexts = questions.map((q) => {
        const header = q.header ? `【${q.header}】` : '';
        return `${header}${q.question}`;
      }).join('\n');

      const title = '❓ DSH: 等待用户输入/确认';
      const body = questionTexts || 'Agent 正在等待您的确认或输入选项';
      dispatchNotification({ title, body, priority: 'high', tags: ['question', 'speech_balloon'] });
    }
    return next();
  });

  // 3. 对话回合正常结束 (Serial)
  ctx.on('agent/turn-stopping', (payload) => {
    if (activeConfig.notifyOnTurnEnd) {
      const turnNum = payload?.turn !== undefined ? ` (第 ${payload.turn} 轮)` : '';
      const title = '✅ DSH: 对话回合结束';
      const body = `AI 已完成当前回合的思考与响应${turnNum}，等待下一轮指令。`;
      dispatchNotification({ title, body, priority: 'default', tags: ['white_check_mark', 'robot'] });
    }
  });

  // 4. 监听底层会话流（全局）：捕获权限请求 approval/asked 以及回合异常结束
  ctx.on('session/event', (_session, event) => {
    if (!event?.type) return;

    // 4.1 权限授权请求：在核心 session.append('approval/asked') 时立即推送
    if (event.type === 'approval/asked') {
      if (!activeConfig.notifyOnApproval) return;
      const toolName = event.data?.toolName || '工具';
      const reason = event.data?.reason || '需要执行操作授权';
      const title = '⚠️ DSH: 等待权限批准';
      const body = `工具 [${toolName}] 请求执行权限：\n${reason}`;
      dispatchNotification({ title, body, priority: 'high', tags: ['warning', 'lock'] });
      return;
    }

    // 4.2 回合结束处理
    if (event.type === 'turn/end') {
      if (!activeConfig.notifyOnError && !activeConfig.notifyOnTurnEnd) return;
      const reason = event.data?.reason;
      if (!reason) return;

      const turn = event.data?.turn;
      const turnText = turn !== undefined ? ` (第 ${turn} 轮)` : '';

      // 运行错误（例如：额度用尽 QUOTA、模型请求报错等）
      if (reason.kind === 'error') {
        if (!activeConfig.notifyOnError) return;
        const err = reason.error || {};
        const code = err.code || '';
        let errMsg = err.message || '';

        if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA' || errMsg.includes('额度已用尽')) {
          errMsg = '当前请求的额度已用尽 (QUOTA)，任务已中止。请检查账号余额或充值。';
        }

        const title = '❌ DSH: 本轮运行失败';
        const body = `本轮对话${turnText}因异常停止：\n${errMsg}${code ? `\n[错误码: ${code}]` : ''}`;
        dispatchNotification({ title, body, priority: 'urgent', tags: ['x', 'warning', 'money_with_wings'] });
        return;
      }

      // 用户主动终止或被信号中断
      if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
        if (!activeConfig.notifyOnError) return;
        let abortDesc = '任务被中断或终止';
        if (reason.reason?.kind === 'hook' && reason.reason?.reason === 'deepseek-account/signed-out') {
          abortDesc = '因账号退出登录，任务已停止。';
        } else if (reason.kind === 'interrupted') {
          abortDesc = 'DSH 进程在任务完成前退出。';
        }
        const title = '⏹️ DSH: 任务已终止';
        const body = `本轮对话${turnText}${abortDesc}`;
        dispatchNotification({ title, body, priority: 'high', tags: ['stop_button', 'warning'] });
        return;
      }

      // 达到 Token 最大上限限制截断
      if (reason.kind === 'max-tokens') {
        if (!activeConfig.notifyOnTurnEnd) return;
        const title = '⚠️ DSH: 已达到最大 Token 限制';
        const body = `本轮对话${turnText}输出达到了上下文 Token 上限，已截断停止。`;
        dispatchNotification({ title, body, priority: 'high', tags: ['warning'] });
      }
    }
  }, { global: true });

  // 5. Agent 错误兜底
  ctx.on('agent/error', (payload) => {
    if (activeConfig.notifyOnError) {
      const errorMsg = payload?.error?.message || String(payload?.error || '未知异常');
      const title = '❌ DSH: 运行异常';
      const body = `第 ${payload?.turn ?? '?'} 轮第 ${payload?.step ?? '?'} 步出错：\n${errorMsg}`;
      dispatchNotification({ title, body, priority: 'urgent', tags: ['x', 'warning'] });
    }
  });
}
