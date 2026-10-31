/**
 * dsh-deepseek-search — browser half.
 *
 * Registers the bundle's configuration page into the Plugins page's
 * `plugins.bundle.config` slot, keyed by this package's name, so the bundle
 * page gets a form instead of only a patch file. The page edits the same
 * volatile Config fields the Host provider reads per operation; the Plugins
 * page owns the save protocol, so this module only stages drafts.
 *
 * The factory id must equal the package name: `dsh-client-modules` attaches a
 * bundle's browser half to the Loader row whose specifier is that name.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-search',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Locale namespace for this page's copy. */
    const NS = 'dshDeepseekSearch'
    /** Host settings form id: the profile row id, not the browser package name. */
    const ENTRY_ID = 'dsh-deepseek-search'

    const en = {
      title: 'DeepSeek Search & Fetch',
      intro: 'Settings are read once per search or fetch, so a saved change applies to the next call.',
      apiKeyEnv: 'Credential reference',
      apiKeyEnvHint: 'Variable name resolved through the credentials service, then the launching environment. The Web search page stores the key itself.',
      baseURL: 'Search / Fetch API base URL',
      baseURLHint: 'Include the /v1/tools prefix; /search and /fetch are appended.',
      count: 'Results per search',
      countHint: 'A whole number from 1 to 50. A request can only lower it.',
      maxRetries: 'Retries',
      maxRetriesHint: 'Retries after the first attempt, for 408, 429 and 5xx responses.',
      retryDelayMs: 'Retry delay (ms)',
      retryDelayMsHint: 'Base delay for exponential backoff.',
      sendOriginalQuestion: 'Send the triggering question',
      sendOriginalQuestionHint: 'Adds ori_question, the human prompt cut to 128 characters.',
      on: 'On',
      off: 'Off',
      invalidRef: 'Use letters, digits and underscores, starting with a letter or underscore.',
      invalidUrl: 'Enter an absolute http or https URL.',
      invalidInteger: 'Enter a whole number in range.',
      unavailable: 'Configuration is unavailable.',
      readOnly: 'This deployment stores settings read-only.',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      save: 'Save',
      saving: 'Saving…',
      overridden: 'Overridden',
      reset: 'Reset to default',
    }

    const zh = {
      title: 'DeepSeek 搜索与抓取',
      intro: '设置会在每次搜索或抓取时读取，保存后对下一次调用生效。',
      apiKeyEnv: '凭据引用',
      apiKeyEnvHint: '经凭据服务解析的变量名，取不到时回落启动环境。密钥本身可在「网页搜索」页保存。',
      baseURL: 'Search / Fetch API 基础地址',
      baseURLHint: '需要包含 /v1/tools 前缀；程序追加 /search 与 /fetch。',
      count: '每次搜索返回条数',
      countHint: '1 到 50 的整数；单次请求只能把它调小。',
      maxRetries: '重试次数',
      maxRetriesHint: '首次尝试之后的重试次数，针对 408、429 与 5xx。',
      retryDelayMs: '重试延迟（毫秒）',
      retryDelayMsHint: '指数退避的基础延迟。',
      sendOriginalQuestion: '发送触发提问',
      sendOriginalQuestionHint: '附带 ori_question：发起本轮的人类提问，截断到 128 字。',
      on: '开',
      off: '关',
      invalidRef: '只能使用字母、数字和下划线，且以字母或下划线开头。',
      invalidUrl: '请填写绝对的 http 或 https 地址。',
      invalidInteger: '请填写范围内的整数。',
      unavailable: '配置不可用。',
      readOnly: '本部署的设置为只读。',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      save: '保存',
      saving: '保存中…',
      overridden: '已覆盖',
      reset: '恢复默认',
    }

    /** Grammar the credentials seam accepts for a reference. */
    const REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/u

    /** Parse an absolute http(s) URL, or nothing when the draft is not one. */
    function parseUrl(text) {
      const value = text.trim()
      if (value === '') return { kind: 'clear' }
      try {
        const url = new URL(value)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
      } catch {
        return undefined
      }
      return { kind: 'set', value }
    }

    /** Parse a bounded integer, or nothing when the draft is not one. */
    function parseInteger(min, max) {
      return (text) => {
        const value = text.trim()
        if (value === '') return { kind: 'clear' }
        const parsed = Number(value)
        if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) return undefined
        return { kind: 'set', value: parsed }
      }
    }

    /** One text-backed field spec, sharing the model's text parsing. */
    function textField(name, parse) {
      return { ...primitives.settingsTextField(name), parse }
    }

    const FIELDS = [
      textField('apiKeyEnv', (text) => {
        const value = text.trim()
        if (value === '') return { kind: 'clear' }
        return REFERENCE.test(value) ? { kind: 'set', value } : undefined
      }),
      textField('baseURL', parseUrl),
      textField('count', parseInteger(1, 50)),
      textField('maxRetries', parseInteger(0)),
      textField('retryDelayMs', parseInteger(0)),
      {
        ...primitives.settingsTextField('sendOriginalQuestion'),
        parse: (text) => (text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined),
      },
    ]

    /** Chrome labels every settings form shell reads. */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /** Render the bundle's configuration page. */
    function BundleConfigPage(props) {
      const { t, view } = props
      if (view !== 'page') return null
      const state = props.useConfig((value) => value)
      const disabled = !state.writable || state.saving

      const field = (name, label, hint, invalidLabel) =>
        h(primitives.SettingsValueField, {
          id: `dsh-deepseek-${name}`,
          key: name,
          label,
          hint,
          ...state[name],
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel,
          disabled,
          onEdit: (value) => {
            props.edit(name, value)
          },
          onReset: () => {
            props.resetField(name)
          },
        })

      const originalQuestion = String(state.sendOriginalQuestion?.text ?? 'true') === 'true' ? 'true' : 'false'

      return h(
        primitives.SettingsForm,
        {
          labels: formLabels(t),
          state,
          onSave: props.save,
          onDiscard: props.discard,
        },
        [
          h('p', { key: 'intro', style: { margin: '0 0 12px', opacity: 0.8 } }, t('intro')),
          field('apiKeyEnv', t('apiKeyEnv'), t('apiKeyEnvHint'), t('invalidRef')),
          field('baseURL', t('baseURL'), t('baseURLHint'), t('invalidUrl')),
          field('count', t('count'), t('countHint'), t('invalidInteger')),
          field('maxRetries', t('maxRetries'), t('maxRetriesHint'), t('invalidInteger')),
          field('retryDelayMs', t('retryDelayMs'), t('retryDelayMsHint'), t('invalidInteger')),
          h(
            'div',
            { key: 'sendOriginalQuestion', style: { marginBottom: 12 } },
            h('label', { htmlFor: 'dsh-deepseek-sendOriginalQuestion', style: { display: 'block', marginBottom: 4 } }, t('sendOriginalQuestion')),
            h(
              'select',
              {
                id: 'dsh-deepseek-sendOriginalQuestion',
                value: originalQuestion,
                disabled,
                onChange: (event) => {
                  props.edit('sendOriginalQuestion', event.target.value)
                },
              },
              [
                h('option', { key: 'on', value: 'true' }, t('on')),
                h('option', { key: 'off', value: 'false' }, t('off')),
              ],
            ),
            h('p', { style: { margin: '4px 0 0', opacity: 0.7 } }, t('sendOriginalQuestionHint')),
          ),
        ],
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }))

        const scope = ctx.configForms.get(ENTRY_ID)
        const form = new primitives.SettingsFormModel(scope, FIELDS)
        ctx.effect(() => () => {
          form.dispose()
        })

        const state = form.bind(() => ({
          ...form.shell(),
          apiKeyEnv: form.field('apiKeyEnv'),
          baseURL: form.field('baseURL'),
          count: form.field('count'),
          maxRetries: form.field('maxRetries'),
          retryDelayMs: form.field('retryDelayMs'),
          sendOriginalQuestion: form.field('sendOriginalQuestion'),
        }))
        const face = { hooks: { config: state }, ...form.actions() }

        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: 'dsh-deepseek-search',
              locale: NS,
              inject: () => face,
            },
            BundleConfigPage,
          ),
        )
      },
    }
  },
})
