import path from 'path'
import { loadEnv } from '../utils/env.js'
import { resolveFunctionsFiles } from '../utils/files.js'
import { meta } from '../config.js'
import {
  findRouteValue,
  pathsToRoutes,
  routeToRegexp,
} from '../utils/api-routes.js'
import { getUrlFromNodeRequest } from '../node/utils.js'
import { polyfillWorkerAPIs, polyfillWebAPIs } from './polyfills.js'
import { normalizePathname, handleFunctionRequest } from './request.js'

const { fnsInDir } = meta

async function prepareEnvironment(params) {
  try {
    await polyfillWorkerAPIs(params)
  } catch (_) {
    await polyfillWebAPIs()
  }

  const { config } = params

  await loadEnv({
    dry: false,
    mode: config.mode,
    root: path.resolve(config.root, fnsInDir),
  })
}

async function watchFnsFiles(
  globs = [],
  { fnsInputPath, watcher, onChange = () => null }
) {
  globs = globs.map((glob) => `${fnsInputPath}/${glob}`)

  const getFileFromPath = (filepath) => {
    const file = filepath.includes('/')
      ? filepath.split(`/${fnsInDir}/`)[1]
      : filepath

    if (file && /\.[jt]sx?$/i.test(file)) {
      return '/' + file.slice(0, file.lastIndexOf('.'))
    }
  }

  const fnsDirFiles = new Set(
    (await resolveFunctionsFiles(globs)).map(getFileFromPath).filter(Boolean)
  )

  watcher.on('add', (path) => {
    const file = getFileFromPath(path)
    if (file) {
      file && fnsDirFiles.add(file)
      onChange(fnsDirFiles)
    }
  })

  watcher.on('unlink', (path) => {
    const file = getFileFromPath(path)
    if (file) {
      file && fnsDirFiles.delete(file)
      onChange(fnsDirFiles)
    }
  })

  onChange(fnsDirFiles)

  return fnsDirFiles
}

function watchPropReload({ fnsInputPath, watcher, ws }) {
  watcher.on('change', (path) => {
    let [, filepath] = path.split(fnsInputPath)
    if (filepath) {
      filepath = filepath.slice(0, filepath.lastIndexOf('.'))
      ws.send({
        type: 'custom',
        event: 'function-reload',
        data: { path: filepath },
      })
    }
  })
}

async function getAllFunctionFiles({ fnsInputPath, watcher }) {
  const dynamicFileRouteSet = await watchFnsFiles(['*'], {
    fnsInputPath,
    watcher,
  })

  const staticApiRouteSet = new Set()
  const dynamicApiRouteMap = new Map()

  await watchFnsFiles(['api/**/*'], {
    fnsInputPath,
    watcher,
    onChange(fnsApiFiles) {
      const { staticRoutes: staticApiRoutes, dynamicRoutes: dynamicApiRoutes } =
        pathsToRoutes([...fnsApiFiles], {
          fnsInputPath,
        })

      staticApiRouteSet.clear()
      staticApiRoutes.forEach((route) =>
        staticApiRouteSet.add(route.toString())
      )

      dynamicApiRouteMap.clear()
      dynamicApiRoutes.forEach((route) => {
        const { keys, pattern } = routeToRegexp(route)
        dynamicApiRouteMap.set(pattern, { keys, value: route })
      })
    },
  })

  return {
    dynamicFileRouteSet,
    staticApiRouteSet,
    dynamicApiRouteMap,
  }
}

let cachedPropsFiles
async function watchAvailablePropsEndpoints({ fnsInputPath, watcher, ws }) {
  const onChange = (fnsPropsFiles) => {
    cachedPropsFiles = fnsPropsFiles

    const sep = '|'
    const names =
      sep +
      Array.from(fnsPropsFiles)
        .join('|')
        .replace(/\/props\//gm, '') +
      sep

    // This will make it available during SSR
    globalThis.__AVAILABLE_PROPS_ENDPOINTS__ = names

    // Send to frontend
    ws.send({
      type: 'custom',
      event: 'props-endpoints-change',
      data: { names },
    })
  }

  if (cachedPropsFiles) {
    onChange(cachedPropsFiles)
  } else {
    await watchFnsFiles(['props/**/*'], {
      fnsInputPath,
      watcher,
      onChange,
    })
  }
}

export async function configureServer({
  middlewares,
  httpServer,
  watcher,
  config,
  ws,
}) {
  const fnsInputPath = `${config.root}/${fnsInDir}`
  await prepareEnvironment({
    config,
    httpServer,
    fnsInputPath,
  })

  const { dynamicFileRouteSet, staticApiRouteSet, dynamicApiRouteMap } =
    await getAllFunctionFiles({ fnsInputPath, watcher })

  await watchAvailablePropsEndpoints({ fnsInputPath, watcher, ws })
  watchPropReload({ fnsInputPath, watcher, ws })

  middlewares.use(async function (req, res, next) {
    const url = getUrlFromNodeRequest(req)

    if (url.pathname.startsWith('/props/')) {
      return await handleFunctionRequest(req, res, {
        fnsInputPath,
        functionPath: url.searchParams.get('propsGetter'),
        extra: url.searchParams.has('data')
          ? JSON.parse(decodeURIComponent(url.searchParams.get('data')))
          : {},
        mockRedirect: !url.searchParams.has('rendering'),
      })
    }

    const normalizedPathname = normalizePathname(url)

    if (
      url.pathname.startsWith('/api/') ||
      dynamicFileRouteSet.has(normalizedPathname)
    ) {
      let params
      let functionPath =
        (dynamicFileRouteSet.has(normalizedPathname) ||
          staticApiRouteSet.has(normalizedPathname)) &&
        normalizedPathname

      if (!functionPath) {
        const match = findRouteValue(normalizedPathname, {
          dynamicMap: dynamicApiRouteMap,
        })

        if (match) {
          params = match.params
          functionPath = match.value.original
        } else {
          console.error(
            new Error(
              `Could not find a file that matches API route ${normalizedPathname}`
            )
          )

          res.statusCode = 500
          return res.end()
        }
      }

      return await handleFunctionRequest(req, res, {
        fnsInputPath,
        functionPath,
        extra: {
          query: url.searchParams,
          params,
          url,
        },
      })
    }

    // Request from frontend to resend the props-endpoints event
    if (url.pathname.startsWith('/__dev-setup-props-watcher')) {
      watchAvailablePropsEndpoints({ ws })
      return res.end()
    }

    next()
  })
}

const WRAP_APPLIED_SYMBOL = Symbol('ssr')

/**
 * Returns the initial state used for the first server-side rendered page.
 * It mimics entry-client logic, but runs in the server.
 */
export async function getRenderContext({
  url,
  resolvedEntryPoint: { resolve },
}) {
  url = new URL(url)

  if (!globalThis.fetch[WRAP_APPLIED_SYMBOL]) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = function (resource, options) {
      if (typeof resource === 'string' && resource.startsWith('/')) {
        resource = url.origin + resource
      }

      return originalFetch(resource, options)
    }

    globalThis.fetch[WRAP_APPLIED_SYMBOL] = true
  }

  const propsRoute = resolve(url)

  if (propsRoute) {
    const [pathname, search] = propsRoute.fullPath.split('?')
    url.pathname = pathname
    url.search = search

    // This will prevent mocking redirect status during rendering
    url.searchParams.append('rendering', true)

    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'manual', // Relay redirects to make the browser change URL
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })

      if (res.status >= 300 && res.status < 400) {
        // Returning a response like this will skip rendering
        return { status: res.status, headers: Object.fromEntries(res.headers) }
      }

      const data = await res.json()
      return { initialState: data, propsStatusCode: res.status }
    } catch (error) {
      console.log(`Could not get page props for route "${propsRoute.name}"`)
      console.error(error)
    }
  }
}
