import fs from 'fs'
import path from 'path'
import { resolveConfig, UserConfig, ResolvedConfig } from './config'
import Rollup, {
  Plugin,
  RollupBuild,
  RollupOptions,
  RollupWarning,
  WarningHandler,
  WarningHandlerWithDefault,
  OutputOptions,
  RollupOutput
} from 'rollup'
import { buildReporterPlugin } from './plugins/reporter'
import { buildDefinePlugin } from './plugins/define'
import chalk from 'chalk'
import { buildHtmlPlugin } from './plugins/html'
import { buildEsbuildPlugin } from './plugins/esbuild'
import { terserPlugin } from './plugins/terser'
import { Terser } from 'types/terser'
import { copyDir, emptyDir, lookupFile } from './utils'
import { manifestPlugin } from './plugins/manifest'
import commonjsPlugin from '@rollup/plugin-commonjs'
import dynamicImportVars from '@rollup/plugin-dynamic-import-vars'
import isBuiltin from 'isbuiltin'
import { Logger } from './logger'

export interface BuildOptions {
  /**
   * Base public path when served in production.
   * @default '/'
   */
  base?: string
  /**
   * Directory relative from `root` where build output will be placed. If the
   * directory exists, it will be removed before the build.
   * @default 'dist'
   */
  outDir?: string
  /**
   * Directory relative from `outDir` where the built js/css/image assets will
   * be placed.
   * @default 'assets'
   */
  assetsDir?: string
  /**
   * Static asset files smaller than this number (in bytes) will be inlined as
   * base64 strings. Default limit is `4096` (4kb). Set to `0` to disable.
   * @default 4096
   */
  assetsInlineLimit?: number
  /**
   * Whether to code-split CSS. When enabled, CSS in async chunks will be
   * inlined as strings in the chunk and inserted via dynamically created
   * style tags when the chunk is loaded.
   * @default true
   */
  cssCodeSplit?: boolean
  /**
   * Whether to generate sourcemap
   * @default false
   */
  sourcemap?: boolean | 'inline'
  /**
   * Set to `false` to disable minification, or specify the minifier to use.
   * Available options are 'terser' or 'esbuild'.
   * @default 'terser'
   */
  minify?: boolean | 'terser' | 'esbuild'
  /**
   * The option for `terser`
   */
  terserOptions?: Terser.MinifyOptions
  /**
   * Will be merged with internal rollup options.
   * https://rollupjs.org/guide/en/#big-list-of-options
   */
  rollupOptions?: RollupOptions
  /**
   * Whether to write bundle to disk
   * @default true
   */
  write?: boolean
  /**
   * Whether to emit a manifest.json under assets dir to map hash-less filenames
   * to their hashed versions. Useful when you want to generate your own HTML
   * instead of using the one generated by Vite.
   *
   * Example:
   *
   * ```json
   * {
   *   "main.js": "main.68fe3fad.js",
   *   "style.css": "style.e6b63442.css"
   * }
   * ```
   * @default false
   */
  manifest?: boolean
  /**
   * Build in library mode. The value should be the global name of the lib in
   * UMD mode. This will produce esm + cjs + umd bundle formats with default
   * configurations that are suitable for distributing libraries.
   */
  lib?: LibraryOptions | false
}

export interface LibraryOptions {
  entry: string
  name?: string
  formats?: LibraryFormats[]
}

export type LibraryFormats = 'es' | 'cjs' | 'umd' | 'iife'

export function resolveBuildOptions(
  raw?: BuildOptions
): Required<BuildOptions> {
  const resolved: Required<BuildOptions> = {
    base: '/',
    outDir: 'dist',
    assetsDir: 'assets',
    assetsInlineLimit: 4096,
    cssCodeSplit: true,
    sourcemap: false,
    rollupOptions: {},
    minify: 'terser',
    terserOptions: {},
    write: true,
    manifest: false,
    lib: false,
    ...raw
  }

  // ensure base ending slash
  resolved.base = resolved.base.replace(/([^/])$/, '$1/')

  // normalize false string into actual false
  if ((resolved.minify as any) === 'false') {
    resolved.minify = false
  }

  return resolved
}

export function resolveBuildPlugins(config: ResolvedConfig): Plugin[] {
  const options = config.build
  return [
    ...(options.rollupOptions.plugins || []),
    commonjsPlugin({
      include: [/node_modules/],
      extensions: ['.js', '.cjs']
    }),
    buildHtmlPlugin(config),
    buildDefinePlugin(config),
    dynamicImportVars({
      warnOnError: true,
      exclude: [/node_modules/]
    }),
    buildEsbuildPlugin(config),
    ...(options.minify && options.minify !== 'esbuild'
      ? [terserPlugin(options.terserOptions)]
      : []),
    ...(options.manifest ? [manifestPlugin()] : []),
    ...(!config.logLevel || config.logLevel === 'info'
      ? [buildReporterPlugin(config)]
      : [])
  ]
}

/**
 * Track parallel build calls and only stop the esbuild service when all
 * builds are done. (#1098)
 */
let parallelCallCounts = 0
// we use a separate counter to track since the call may error before the
// bundle is even pushed.
const paralellBuilds: RollupBuild[] = []

/**
 * Bundles the app for production.
 * Returns a Promise containing the build result.
 */
export async function build(
  inlineConfig: UserConfig & { mode?: string } = {},
  configPath?: string | false
): Promise<RollupOutput | RollupOutput[]> {
  parallelCallCounts++
  try {
    return await doBuild(inlineConfig, configPath)
  } finally {
    parallelCallCounts--
    if (parallelCallCounts <= 0) {
      paralellBuilds.forEach((bundle) => bundle.close())
      paralellBuilds.length = 0
    }
  }
}

async function doBuild(
  inlineConfig: UserConfig & { mode?: string } = {},
  configPath?: string | false
): Promise<RollupOutput | RollupOutput[]> {
  const mode = inlineConfig.mode || 'production'
  const config = await resolveConfig(inlineConfig, 'build', mode, configPath)

  config.logger.info(chalk.cyan(`[vite] building for production...`))

  const options = config.build
  const libOptions = options.lib
  const resolve = (p: string) => path.resolve(config.root, p)

  const input = libOptions
    ? libOptions.entry
    : options.rollupOptions?.input || resolve('index.html')
  const outDir = resolve(options.outDir)
  const publicDir = resolve('public')

  const rollup = require('rollup') as typeof Rollup

  try {
    const bundle = await rollup.rollup({
      input,
      preserveEntrySignatures: libOptions ? 'strict' : false,
      ...options.rollupOptions,
      plugins: config.plugins as Plugin[],
      onwarn(warning, warn) {
        onRollupWarning(warning, warn, [], options.rollupOptions?.onwarn)
      }
    })

    paralellBuilds.push(bundle)

    const pkgName =
      libOptions &&
      JSON.parse(lookupFile(config.root, ['package.json']) || `{}`).name

    const generate = (output: OutputOptions = {}) => {
      return bundle[options.write ? 'write' : 'generate']({
        dir: outDir,
        format: 'es',
        exports: 'auto',
        sourcemap: options.sourcemap,
        name: libOptions ? libOptions.name : undefined,
        entryFileNames: libOptions
          ? `${pkgName}.${output.format || `es`}.js`
          : path.posix.join(options.assetsDir, `[name].[hash].js`),
        chunkFileNames: libOptions
          ? `[name].js`
          : path.posix.join(options.assetsDir, `[name].[hash].js`),
        assetFileNames: libOptions
          ? `[name].[ext]`
          : path.posix.join(options.assetsDir, `[name].[hash].[ext]`),
        // #764 add `Symbol.toStringTag` when build es module into cjs chunk
        // #1048 add `Symbol.toStringTag` for module default export
        namespaceToStringTag: true,
        ...output
      })
    }

    if (options.write) {
      emptyDir(outDir)
      if (fs.existsSync(publicDir)) {
        copyDir(publicDir, outDir)
      }
    }

    // resolve lib mode outputs
    const outputs = resolveBuildOutputs(
      options.rollupOptions?.output,
      libOptions,
      config.logger
    )
    if (Array.isArray(outputs)) {
      return Promise.all(outputs.map(generate))
    } else {
      return generate(outputs)
    }
  } catch (e) {
    config.logger.error(
      chalk.red(`${e.plugin ? `[${e.plugin}] ` : ``}${e.message}`)
    )
    if (e.id) {
      const loc = e.loc ? `:${e.loc.line}:${e.loc.column}` : ``
      config.logger.error(`file: ${chalk.cyan(`${e.id}${loc}`)}`)
    }
    if (e.frame) {
      config.logger.error(chalk.yellow(e.frame))
    }
    throw e
  }
}

function resolveBuildOutputs(
  outputs: OutputOptions | OutputOptions[] | undefined,
  libOptions: LibraryOptions | false,
  logger: Logger
): OutputOptions | OutputOptions[] | undefined {
  if (libOptions) {
    const formats = libOptions.formats || ['es', 'umd']
    if (
      (formats.includes('umd') || formats.includes('iife')) &&
      !libOptions.name
    ) {
      throw new Error(
        `Option "build.lib.name" is required when output formats ` +
          `include "umd" or "iife".`
      )
    }
    if (!outputs) {
      return formats.map((format) => ({ format }))
    } else if (!Array.isArray(outputs)) {
      return formats.map((format) => ({ ...outputs, format }))
    } else if (libOptions.formats) {
      // user explicitly specifying own output array
      logger.warn(
        chalk.yellow(
          `"build.lib.formats" will be ignored because ` +
            `"build.rollupOptions.output" is already an array format`
        )
      )
    }
  }
  return outputs
}

const warningIgnoreList = [`CIRCULAR_DEPENDENCY`, `THIS_IS_UNDEFINED`]
const dynamicImportWarningIgnoreList = [
  `Unsupported expression`,
  `statically analyzed`
]

export function onRollupWarning(
  warning: RollupWarning,
  warn: WarningHandler,
  allowNodeBuiltins: string[] = [],
  userOnWarn?: WarningHandlerWithDefault
) {
  if (warning.code === 'UNRESOLVED_IMPORT') {
    let message: string
    const id = warning.source
    const importer = warning.importer
    if (id && isBuiltin(id)) {
      let importingDep
      if (importer) {
        const pkg = JSON.parse(lookupFile(importer, ['package.json']) || `{}`)
        if (pkg.name) {
          importingDep = pkg.name
        }
      }
      if (importingDep && allowNodeBuiltins.includes(importingDep)) {
        return
      }
      const dep = importingDep
        ? `Dependency ${chalk.yellow(importingDep)}`
        : `A dependency`
      message =
        `${dep} is attempting to import Node built-in module ${chalk.yellow(
          id
        )}.\n` +
        `This will not work in a browser environment.\n` +
        `Imported by: ${chalk.gray(importer)}`
    } else {
      message =
        `[vite]: Rollup failed to resolve import "${warning.source}" from "${warning.importer}".\n` +
        `This is most likely unintended because it can break your application at runtime.\n` +
        `If you do want to externalize this module explicitly add it to\n` +
        `\`rollupInputOptions.external\``
    }
    throw new Error(message)
  }
  if (
    warning.plugin === 'rollup-plugin-dynamic-import-variables' &&
    dynamicImportWarningIgnoreList.some((msg) => warning.message.includes(msg))
  ) {
    return
  }

  if (!warningIgnoreList.includes(warning.code!)) {
    if (userOnWarn) {
      userOnWarn(warning, warn)
    } else {
      warn(warning)
    }
  }
}