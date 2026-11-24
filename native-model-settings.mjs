import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

// Cordis 每次 ctx.get 都会包一层追踪代理；原始服务身份用于缓存，方法仍通过代理调用。
const serviceIdentity = llm => llm?.[Symbol.for('cordis.original')] ?? llm;

export class NativeModelSettings {
  constructor({ stateDir = resolveRuntimePaths().stateDir, llm, getLlm, now = Date.now, catalogTtlMs = 60_000, catalogTimeoutMs = 5_000 } = {}) {
    this.file = path.join(stateDir, 'native-model.json'); this.initialLlm = llm; this.getLlm = getLlm;
    this.now = now; this.catalogTtlMs = catalogTtlMs; this.catalogTimeoutMs = catalogTimeoutMs;
    this.cachedCatalog = null; this.catalogPending = null;
  }
  get llm() { return this.getLlm ? this.getLlm() : this.initialLlm; }
  providers(llm = this.llm) {
    return typeof llm?.listProviders === 'function' ? llm.listProviders().map(({ id, name, displayName }) => ({ id, name: name || displayName || id })) : [];
  }
  catalogKey(providers) { return JSON.stringify(providers.map(item => item.id).sort()); }
  state() {
    let saved = { provider: '', model: '' };
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('原生模型设置损坏，请核对文件。'); }
    if (!saved || typeof saved.provider !== 'string' || typeof saved.model !== 'string' || saved.provider.length > 200 || saved.model.length > 300) throw new Error('原生模型设置格式无效。');
    // 观看模型可选：没配就是空字符串，走主模型；配了也要是合法字符串，和主模型同一长度上限。
    if ((saved.watchProvider !== undefined && (typeof saved.watchProvider !== 'string' || saved.watchProvider.length > 200)) || (saved.watchModel !== undefined && (typeof saved.watchModel !== 'string' || saved.watchModel.length > 300))) throw new Error('原生模型设置格式无效。');
    const watchProvider = saved.watchProvider || '', watchModel = saved.watchModel || '';
    const llm = this.llm, identity = serviceIdentity(llm), providers = this.providers(llm), key = this.catalogKey(providers);
    const catalog = this.cachedCatalog && this.cachedCatalog.identity === identity && this.cachedCatalog.key === key ? this.cachedCatalog : null;
    const models = catalog?.models.map(item => ({ ...item, ...(item.inputModalities ? { inputModalities: [...item.inputModalities] } : {}) })) || [];
    const providerAvailable = providers.some(item => item.id === saved.provider);
    const watchProviderAvailable = providers.some(item => item.id === watchProvider);
    return { ...saved, watchProvider, watchModel, providers, models, catalogLoaded: Boolean(catalog), catalogErrors: catalog?.errors.map(item => ({ ...item })) || [], configured: Boolean(saved.provider && saved.model && providerAvailable && (!catalog || models.some(item => item.provider === saved.provider && item.id === saved.model))), watchConfigured: Boolean(watchProvider && watchModel && watchProviderAvailable && (!catalog || models.some(item => item.provider === watchProvider && item.id === watchModel))) };
  }
  // 按用途取模型：watch 有单独配置就用便宜模型，没配就回落主模型；reply 永远用主模型。
  routeFor(purpose = 'reply') {
    if (purpose !== 'watch' && purpose !== 'reply') throw new Error('模型用途只能是 watch 或 reply。');
    const { provider, model, watchProvider, watchModel } = this.state();
    if (purpose === 'watch' && watchProvider && watchModel) return { provider: watchProvider, model: watchModel };
    return { provider, model };
  }
  async catalog({ force = false } = {}) {
    const llm = this.llm, identity = serviceIdentity(llm), providers = this.providers(llm), key = this.catalogKey(providers);
    if (!llm) return this.state();
    if (this.catalogPending?.identity === identity && this.catalogPending.key === key) { await this.catalogPending.promise; return this.state(); }
    if (!force && this.cachedCatalog?.identity === identity && this.cachedCatalog.key === key && this.now() - this.cachedCatalog.time < this.catalogTtlMs) return this.state();
    const pending = { identity, key };
    pending.promise = Promise.all(providers.map(async ({ id: provider }) => {
      if (typeof llm.listModels !== 'function') return { models: [], error: { provider, message: 'DSH 模型目录服务尚未就绪，请稍后刷新。' } };
      let timer;
      try {
        // listModels 复用 DSH 已配置目录；不调用主动发现、凭据读取或模型生成。
        const entries = await Promise.race([Promise.resolve().then(() => llm.listModels(provider)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('目录查询超时')), this.catalogTimeoutMs); })]);
        if (!Array.isArray(entries)) throw new Error('目录格式无效');
        const seen = new Set(), models = entries.map(item => {
          if (!item || item.provider !== provider || typeof item.id !== 'string' || !item.id || item.id.length > 300 || typeof item.name !== 'string' || !item.name || seen.has(item.id)) throw new Error('目录格式无效');
          seen.add(item.id);
          return { provider, id: item.id, name: item.name, ...(Array.isArray(item.inputModalities) ? { inputModalities: item.inputModalities.filter(value => ['text', 'image'].includes(value)) } : {}) };
        });
        return { models, ...(!models.length ? { error: { provider, message: '模型目录为空，请先在 DSH「模型」中配置该提供商的可用模型。' } } : {}) };
      } catch {
        return { models: [], error: { provider, message: '无法读取此提供商的模型目录，请检查 DSH「模型」设置后刷新。' } };
      } finally { clearTimeout(timer); }
    })).then(groups => {
      if (serviceIdentity(this.llm) === identity && this.catalogKey(this.providers()) === key) this.cachedCatalog = { identity, key, time: this.now(), models: groups.flatMap(item => item.models), errors: groups.flatMap(item => item.error ? [item.error] : []) };
    }).finally(() => { if (this.catalogPending === pending) this.catalogPending = null; });
    this.catalogPending = pending;
    await pending.promise;
    return this.state();
  }
  async configure(input, { explicit = false, beforeCommit } = {}) {
    if (!explicit || !input || Object.keys(input).some(key => !['provider', 'model', 'watchProvider', 'watchModel'].includes(key)) || typeof input.provider !== 'string' || typeof input.model !== 'string' || !input.provider.trim() || !input.model.trim() || input.provider.length > 200 || input.model.length > 300) throw Object.assign(new Error('请从 DSH 已配置提供商中选择模型。'), { status: 400 });
    const hasWatch = input.watchProvider !== undefined || input.watchModel !== undefined;
    // 观看模型要么两个键都不传（保留已存的，旧前端只发主模型时不丢配置），要么两个一起传；
    // 两个都留空表示清除，只填一个拒绝。和主模型同一校验规则。
    if (hasWatch && (typeof input.watchProvider !== 'string' || typeof input.watchModel !== 'string' || input.watchProvider.length > 200 || input.watchModel.length > 300 || Boolean(input.watchProvider.trim()) !== Boolean(input.watchModel.trim()))) throw Object.assign(new Error('观看模型请同时选择提供商和模型，或两个都留空清除。'), { status: 400 });
    const saved = this.state();
    if (!saved.providers.some(item => item.id === input.provider)) throw Object.assign(new Error('此模型提供商尚未在 DSH 配置。'), { status: 400 });
    const watchProvider = hasWatch ? input.watchProvider.trim() : saved.watchProvider, watchModel = hasWatch ? input.watchModel.trim() : saved.watchModel;
    if (watchProvider && !saved.providers.some(item => item.id === watchProvider)) throw Object.assign(new Error('此模型提供商尚未在 DSH 配置。'), { status: 400 });
    const llm = this.llm, identity = serviceIdentity(llm), model = input.model.trim();
    if (typeof llm?.resolveModelInfo !== 'function') throw new Error('DSH 模型服务尚未就绪。');
    const requireSelection = (state, provider, modelId) => {
      if (!state.providers.some(item => item.id === provider)) throw Object.assign(new Error('此模型提供商尚未在 DSH 配置。'), { status: 400 });
      if (!state.models.some(item => item.provider === provider && item.id === modelId)) throw Object.assign(new Error(state.catalogErrors.find(item => item.provider === provider)?.message || '此模型不在 DSH 可用目录中，请刷新后重新选择。'), { status: 400 });
    };
    requireSelection(await this.catalog(), input.provider, model);
    await llm.resolveModelInfo(input.provider, model, AbortSignal.timeout(15_000));
    if (watchProvider && watchModel) {
      requireSelection(await this.catalog(), watchProvider, watchModel);
      await llm.resolveModelInfo(watchProvider, watchModel, AbortSignal.timeout(15_000));
    }
    requireSelection(await this.catalog({ force: true }), input.provider, model);
    if (watchProvider && watchModel) requireSelection(await this.catalog({ force: true }), watchProvider, watchModel);
    if (beforeCommit) await beforeCommit();
    if (serviceIdentity(this.llm) !== identity || !this.providers().some(item => item.id === input.provider) || (watchProvider && !this.providers().some(item => item.id === watchProvider))) throw Object.assign(new Error('DSH 模型提供商已变化，请刷新后重新选择。'), { status: 409 });
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify({ provider: input.provider, model, ...(watchProvider && watchModel ? { watchProvider, watchModel } : {}) }), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return this.state();
  }
}
