import { serveStatic } from '@hono/node-server/serve-static'
import preactRenderToString from 'preact-render-to-string'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { log } from '../lib/logger.js'
import * as esbuild from 'esbuild'
import path from 'node:path'
import { getRoutes } from '../core/router.js'

// TODO: create an abstraction over HONO to create a new CTX
// that's common and usable for most cases
function mapHonoCtxToPrev(ctx) {
  return ctx
}

const server = {
  activeInstance: undefined,
  app: undefined,
  port: undefined,

  /**
   * @param {object} options
   * @param {boolean} [options.force=false]
   * Initialize the server singleton, and create the hono
   * app instance if it didn't exist.
   */
  async init({ force = false }) {
    if (this.activeInstance && !force) {
      return
    }

    if (this.activeInstance && force) {
      log.debug('Force Restarting Server')
      await this.close()
    }

    if (!this.app) {
      this.app = new Hono()
    }

    this.activeInstance = serve(
      {
        fetch: this.app.fetch,
        port: this.port,
      },
      info => {
        console.log(`Listening on http://localhost:${info.port}`)
      }
    )
  },
  close() {
    const self = this

    return new Promise(resolve => {
      if (!self.activeInstance) {
        log.debug('nothing to shut down')
        resolve()
      }
      self.activeInstance.close(err => {
        if (err) {
          if (err.code === 'ERR_SERVER_NOT_RUNNING') {
            resolve()
            return
          }
          console.error(err)
          throw err
        }
        self.activeInstance = undefined
        resolve()
      })
    })
  },
}

export async function kernel({
  isDev,
  serverPort,
  liveServerPort,
  plugRegister,
  baseDir,
  clientDirectory,
}) {
  const app = new Hono()
  server.app = app
  server.port = serverPort || process.env.PORT || 3000

  const routes = getRoutes()
  for (const method of Object.keys(routes)) {
    for (const route of Object.keys(routes[method])) {
      const details = routes[method][route]
      if (method === 'get') {
        app[method](details.url, async _ctx => {
          const ctx = mapHonoCtxToPrev(_ctx)
          const result = await details.handler(ctx)
          if (!result) return
          if (result instanceof Response) return result

          ctx.header('content-type', 'text/html')
          return ctx.html(
            await renderer(result, plugRegister, {
              isDev,
              outDir: baseDir,
              liveServerPort,
              clientDirectory,
            })
          )
        })
      } else {
        app[method](details.url, _ctx => {
          const ctx = mapHonoCtxToPrev(_ctx)
          return details.handler(ctx)
        })
      }
    }
  }

  server.app.get(
    '/public/*',
    serveStatic({
      root: path.relative(
        '.',
        path.resolve(path.join(baseDir, clientDirectory))
      ),
      rewriteRequestPath: p => {
        return p.replace('/public/', '/')
      },
    })
  )

  await server.init({ force: true })

  return server
}

async function renderer(
  comp,
  plugRegister,
  { isDev, outDir, liveServerPort, clientDirectory } = {}
) {
  const html = preactRenderToString(comp)
  const htmlTree = plugRegister.reduce(
    (acc, x) => {
      return x.render ? x.render(acc) : acc
    },
    {
      head: [],
      body: [html],
    }
  )
  await esbuild.build({
    stdin: {
      contents: getInjectableLiveSource(liveServerPort),
      loader: 'ts',
      resolveDir: './',
    },
    platform: 'browser',
    outfile: `${path.join(outDir, clientDirectory, 'live-reload.prev.js')}`,
    bundle: true,
    format: 'esm',
  })

  const liveReloadSourceScript = `
    <script src="/public/live-reload.prev.js"></script>
  `

  return `
    <!DOCTYPE html>
    <html>
      ${htmlTree.head.join('\n')}
      ${htmlTree.body.join('\n')}
      ${isDev ? liveReloadSourceScript : ''}
    </html>
  `
}

function getInjectableLiveSource(serverPort) {
  return `
      import { DiffDOM } from 'diff-dom'

      const es = new EventSource('http://localhost:${serverPort}/live')

      es.onopen = () => {
        console.log('Connected to prev')
      }

      es.onmessage = () => {
        fetch(location.href)
          .then(x => x.text())
          .then(d => {
            var parser = new DOMParser()
            const doc = parser.parseFromString(d.trim(), 'text/html')
            const newBody = doc.querySelector('body')
            const newHead = doc.querySelector('head')

            const dd = new DiffDOM()
            const diff = dd.diff(document.body, newBody)
            const diffHead = dd.diff(document.head, newHead)
            dd.apply(document.body, diff)
            dd.apply(document.head, diffHead)
          })
      }
  `
}
