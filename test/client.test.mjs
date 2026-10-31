import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Run the browser half's factory against stubbed loader globals.
 *
 * The real module needs `window.__ModuleLoader__` and the browser module table;
 * this harness supplies both so the registration logic and the rendered form
 * tree can be checked without a browser. It does not prove the shipped
 * primitives accept the same calls — only that this file wires them as
 * intended.
 */
function loadClientHalf() {
  let definition
  const window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  new Function('window', source)(window)
  return definition
}

/** A render tree node, enough to assert on shape and children. */
function createElement(type, props, children) {
  return { type, props, children }
}

const REACT = { createElement, useId: () => 'id', Fragment: 'Fragment' }

/** Records the calls the page makes, so the test asserts the wiring contract. */
function createPrimitives(state) {
  return {
    settingsTextField: (name) => ({ name }),
    SettingsForm: 'SettingsForm',
    SettingsValueField: 'SettingsValueField',
    SettingsFormModel: class {
      constructor(scope, fields) {
        this.scope = scope
        this.fields = fields
      }

      shell() {
        return { writable: true, saving: false }
      }

      field(name) {
        return { text: String(this.scope.value[name]), overridden: false, invalid: false }
      }

      bind(select) {
        return select
      }

      actions() {
        return { edit() {}, save() {}, discard() {}, resetField() {} }
      }

      dispose() {}
    },
  }
}

function createContext(calls) {
  const value = {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1/tools',
    count: 10,
    maxRetries: 2,
    retryDelayMs: 800,
    sendOriginalQuestion: true,
  }
  return {
    effect: (fn) => fn(),
    locale: {
      register(namespace, texts) {
        calls.locale = { namespace, texts }
        return () => {}
      },
    },
    configForms: {
      get(entryId) {
        calls.entryId = entryId
        return { value }
      },
    },
    slots: {
      inject(name, register) {
        calls.slot = name
        return register()
      },
      register(options, component) {
        calls.registration = { options, component }
        return () => {}
      },
    },
  }
}

test('browser half: registers a bundle config page for this package', () => {
  const definition = loadClientHalf()
  assert.equal(definition.id, 'dsh-deepseek-search')

  const calls = {}
  const module = definition.factory((id) => {
    if (id === 'react') return REACT
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return createPrimitives()
    throw new Error(`unexpected require: ${id}`)
  })
  assert.deepEqual(module.inject, ['slots', 'locale', 'configForms'])

  module.apply(createContext(calls))
  assert.equal(calls.slot, 'plugins.bundle.config')
  assert.equal(calls.registration.options.name, 'plugins.bundle.config')
  assert.equal(calls.registration.options.key, 'dsh-deepseek-search')
  assert.equal(calls.registration.options.locale, 'dshDeepseekSearch')
  assert.equal(calls.entryId, 'dsh-deepseek-search')
  assert.equal(calls.locale.namespace, 'dshDeepseekSearch')
  assert.ok(calls.locale.texts.en.title)
  assert.ok(calls.locale.texts.zh.title)
})

test('browser half: the page renders every editable field and its save chrome', () => {
  const definition = loadClientHalf()
  const calls = {}
  const module = definition.factory((id) => {
    if (id === 'react') return REACT
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return createPrimitives()
    throw new Error(`unexpected require: ${id}`)
  })
  module.apply(createContext(calls))

  const face = calls.registration.options.inject()
  assert.ok(face.hooks.config)
  const tree = calls.registration.component({
    t: (key) => key,
    view: 'page',
    useConfig: face.hooks.config,
    edit: face.edit,
    save: face.save,
    discard: face.discard,
    resetField: face.resetField,
  })

  assert.equal(tree.type, 'SettingsForm')
  assert.equal(tree.props.state.writable, true)
  const fields = tree.children.filter((child) => child.type === 'SettingsValueField')
  assert.deepEqual(
    fields.map((child) => child.props.label),
    ['apiKeyEnv', 'baseURL', 'count', 'maxRetries', 'retryDelayMs'],
  )
  assert.equal(fields[0].props.id, 'dsh-deepseek-apiKeyEnv')
  assert.equal(tree.children.at(-1).props.key, 'sendOriginalQuestion')
})

test('browser half: summary and other views render nothing', () => {
  const definition = loadClientHalf()
  const calls = {}
  const module = definition.factory((id) => {
    if (id === 'react') return REACT
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return createPrimitives()
    throw new Error(`unexpected require: ${id}`)
  })
  module.apply(createContext(calls))
  const face = calls.registration.options.inject()
  const tree = calls.registration.component({ t: (key) => key, view: 'summary', useConfig: face.hooks.config })
  assert.equal(tree, null)
})
