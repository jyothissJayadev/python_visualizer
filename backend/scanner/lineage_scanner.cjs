#!/usr/bin/env node
/**
 * backend/scanner/lineage_scanner.cjs
 *
 * Full-stack static AST lineage analyzer across:
 *   1. Brain (FastAPI endpoints)
 *   2. Backend (Node.js/Express: services/brainClient -> controllers -> routes)
 *   3. Client API Layer (apps/frontend and apps/admin API clients)
 *   4. UI Components & Triggers (React components, hooks, event handlers)
 *
 * Runs read-only on the target repository using @babel/parser and @babel/traverse.
 */

const fs = require('fs');
const path = require('path');
const parser = require('/usr/share/nodejs/@babel/parser');
const traverse = require('/usr/share/nodejs/@babel/traverse').default;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    brain: '',
    backend: '',
    frontend: '',
    admin: '',
    endpointsJson: '',
    output: ''
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--brain' && args[i + 1]) opts.brain = args[++i];
    else if (args[i] === '--backend' && args[i + 1]) opts.backend = args[++i];
    else if (args[i] === '--frontend' && args[i + 1]) opts.frontend = args[++i];
    else if (args[i] === '--admin' && args[i + 1]) opts.admin = args[++i];
    else if (args[i] === '--endpoints-json' && args[i + 1]) opts.endpointsJson = args[++i];
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function resolveDirectories(opts) {
  let brainDir = opts.brain;
  if (!brainDir) {
    brainDir = process.env.BRAIN_TERMINAL_PROJECT || '/run/media/jyothiss/main/code/atomics_estimate_engine/apps/brain';
  }
  brainDir = path.resolve(brainDir);

  const appsDir = path.dirname(brainDir);
  const repoDir = path.dirname(appsDir);

  const backendDir = opts.backend ? path.resolve(opts.backend) : path.join(appsDir, 'backend');
  const frontendDir = opts.frontend ? path.resolve(opts.frontend) : path.join(appsDir, 'frontend/src');
  const adminDir = opts.admin ? path.resolve(opts.admin) : path.join(appsDir, 'admin/src');

  return { brainDir, appsDir, repoDir, backendDir, frontendDir, adminDir };
}

function parseCode(code, filepath) {
  try {
    return parser.parse(code, {
      sourceType: 'module',
      plugins: [
        'jsx',
        'typescript',
        'classProperties',
        'decorators-legacy',
        'objectRestSpread',
        'exportDefaultFrom',
        'dynamicImport'
      ]
    });
  } catch (e) {
    return null;
  }
}

function parseFile(filepath) {
  try {
    const code = fs.readFileSync(filepath, 'utf8');
    return parseCode(code, filepath);
  } catch (e) {
    return null;
  }
}

function walkFiles(dir, extRegex) {
  const results = [];
  function _walk(d) {
    let items;
    try { items = fs.readdirSync(d); } catch (e) { return; }
    for (const item of items) {
      if (item === 'node_modules' || item.startsWith('.')) continue;
      const full = path.join(d, item);
      let stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }
      if (stat.isDirectory()) _walk(full);
      else if (extRegex.test(full)) results.push(full);
    }
  }
  _walk(dir);
  return results;
}

function isParam(seg) {
  if (!seg) return false;
  return /^\{.+\}$/.test(seg) || /^:[a-zA-Z0-9_]+$/.test(seg) || seg === ':param' || seg.startsWith('{') || seg.startsWith(':');
}

function pathsMatch(pathA, pathB) {
  if (!pathA || !pathB) return false;
  const cleanA = pathA.split('?')[0].replace(/\/+/g, '/').replace(/\/$/, '');
  const cleanB = pathB.split('?')[0].replace(/\/+/g, '/').replace(/\/$/, '');
  if (cleanA === cleanB) return true;

  const segsA = cleanA.split('/').filter(Boolean);
  const segsB = cleanB.split('/').filter(Boolean);
  if (segsA.length !== segsB.length) return false;

  for (let i = 0; i < segsA.length; i++) {
    const pA = isParam(segsA[i]);
    const pB = isParam(segsB[i]);
    if (pA && pB) continue;
    if (pA || pB) return false; // Never match a static segment to a parameterized segment
    if (segsA[i] !== segsB[i]) return false;
  }
  return true;
}

// ── 1. Backend Service Scanner: calls to brain ──────────────────────────────
function scanBackendServices(backendDir) {
  const serviceCalls = [];
  const servicesDir = path.join(backendDir, 'services');
  const serviceFiles = walkFiles(servicesDir, /\.js$/);

  // Always include brainClient.service.js and health.routes.js if present
  const healthRoute = path.join(backendDir, 'routes/health.routes.js');
  if (fs.existsSync(healthRoute)) serviceFiles.push(healthRoute);

  for (const sFile of serviceFiles) {
    const code = fs.readFileSync(sFile, 'utf8');
    if (!code.includes('callBrain') && !code.includes('BRAIN_BASE_URL') && !code.includes('8000') && !code.includes('fetch')) {
      continue;
    }

    const ast = parseFile(sFile);
    if (!ast) continue;

    traverse(ast, {
      ExportNamedDeclaration(p) {
        let funcName = null;
        let startLine = null;
        if (p.node.declaration?.type === 'FunctionDeclaration') {
          funcName = p.node.declaration.id.name;
          startLine = p.node.declaration.loc.start.line;
        } else if (p.node.declaration?.type === 'VariableDeclaration') {
          funcName = p.node.declaration.declarations[0]?.id?.name;
          startLine = p.node.declaration.loc.start.line;
        }
        if (!funcName) return;

        p.traverse({
          CallExpression(cp) {
            const callee = cp.node.callee;
            const calleeName = callee.name || (callee.property && callee.property.name);
            if (calleeName === 'callBrain' || calleeName === 'fetch') {
              const firstArg = cp.node.arguments[0];
              let urlVal = null;
              if (firstArg?.type === 'StringLiteral') {
                urlVal = firstArg.value;
              } else if (firstArg?.type === 'TemplateLiteral') {
                urlVal = firstArg.quasis.map((q, i) => {
                  const expr = firstArg.expressions[i];
                  let exprName = '';
                  if (expr) {
                    if (expr.type === 'Identifier') {
                      if (expr.name === 'BASE_URL' || expr.name === 'BRAIN_BASE_URL') {
                        exprName = '';
                      } else {
                        exprName = `{${expr.name}}`;
                      }
                    } else if (expr.type === 'CallExpression' && expr.arguments[0]?.name) {
                      exprName = `{${expr.arguments[0].name}}`;
                    } else {
                      exprName = ':param';
                    }
                  }
                  return q.value.raw + exprName;
                }).join('');
              }

              if (urlVal && (urlVal.startsWith('/') || urlVal.includes('BASE_URL') || urlVal.includes('/health'))) {
                let cleanPath = urlVal.replace(/^.*\{?(?:BASE_URL|BRAIN_BASE_URL)\}?\/?/, '/').split('?')[0];
                if (!cleanPath.startsWith('/')) cleanPath = '/' + cleanPath;
                let method = 'POST';
                const optsArg = cp.node.arguments[2] || cp.node.arguments[1];
                if (optsArg && optsArg.type === 'ObjectExpression') {
                  for (const prop of optsArg.properties) {
                    if (prop.key?.name === 'method' && prop.value?.type === 'StringLiteral') {
                      method = prop.value.value.toUpperCase();
                    }
                  }
                }
                if (sFile.includes('health')) method = 'GET';

                const fullCleanPath = cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath;
                serviceCalls.push({
                  serviceFunc: funcName,
                  rawPath: urlVal,
                  cleanPath: fullCleanPath,
                  method,
                  file: path.relative(backendDir, sFile),
                  line: cp.node.loc.start.line
                });
              }
            }
          }
        });
      }
    });
  }
  return serviceCalls;
}

// ── 2. Backend Controller Scanner ───────────────────────────────────────────
function scanBackendControllers(backendDir, serviceCalls) {
  const controllerMap = new Map(); // serviceFunc -> [ { controllerFunc, file, line } ]
  const controllerFiles = walkFiles(path.join(backendDir, 'controllers'), /\.js$/);

  for (const cFile of controllerFiles) {
    const code = fs.readFileSync(cFile, 'utf8');
    const matchingFuncs = serviceCalls.filter(sc => code.includes(sc.serviceFunc));
    if (matchingFuncs.length === 0) continue;

    const ast = parseFile(cFile);
    if (!ast) continue;

    const importedFuncs = new Set();
    traverse(ast, {
      ImportDeclaration(p) {
        if (p.node.source.value.includes('service')) {
          for (const s of p.node.specifiers) {
            if (matchingFuncs.some(mf => mf.serviceFunc === s.local.name)) {
              importedFuncs.add(s.local.name);
            }
          }
        }
      }
    });

    if (importedFuncs.size === 0) continue;

    traverse(ast, {
      ExportNamedDeclaration(p) {
        let funcName = null;
        let line = null;
        if (p.node.declaration?.type === 'FunctionDeclaration') {
          funcName = p.node.declaration.id.name;
          line = p.node.declaration.loc.start.line;
        } else if (p.node.declaration?.type === 'VariableDeclaration') {
          funcName = p.node.declaration.declarations[0]?.id?.name;
          line = p.node.declaration.loc.start.line;
        }
        if (!funcName) return;

        p.traverse({
          CallExpression(cp) {
            const name = cp.node.callee.name;
            if (name && importedFuncs.has(name)) {
              if (!controllerMap.has(name)) controllerMap.set(name, []);
              const arr = controllerMap.get(name);
              if (!arr.some(x => x.controllerFunc === funcName && x.file === cFile)) {
                arr.push({
                  controllerFunc: funcName,
                  file: path.relative(backendDir, cFile),
                  line
                });
              }
            }
          }
        });
      }
    });
  }
  return controllerMap;
}

// ── 3. Backend Routes Scanner ───────────────────────────────────────────────
function scanBackendRoutes(backendDir) {
  const routesIndexFile = path.join(backendDir, 'routes/index.js');
  const mountTable = {};
  const routerImportToFile = {};

  if (fs.existsSync(routesIndexFile)) {
    const routesIndexCode = fs.readFileSync(routesIndexFile, 'utf8');
    const routesIndexAst = parseCode(routesIndexCode, 'routes/index.js');
    if (routesIndexAst) {
      traverse(routesIndexAst, {
        ImportDeclaration(p) {
          const src = p.node.source.value;
          for (const spec of p.node.specifiers) {
            routerImportToFile[spec.local.name] = path.resolve(backendDir, 'routes', src);
          }
        },
        CallExpression(p) {
          if (p.node.callee?.object?.name === 'app' && p.node.callee?.property?.name === 'use') {
            const prefixArg = p.node.arguments[0];
            const routerArg = p.node.arguments[1];
            if (prefixArg?.type === 'StringLiteral' && routerArg?.type === 'Identifier') {
              mountTable[routerArg.name] = prefixArg.value;
            }
          }
        }
      });
    }
  }

  const filePrefixMap = {};
  for (const [rVar, rFile] of Object.entries(routerImportToFile)) {
    const prefix = mountTable[rVar] || '';
    filePrefixMap[rFile] = prefix;
    if (!rFile.endsWith('.js')) {
      filePrefixMap[rFile + '.js'] = prefix;
    }
  }

  const routeFiles = walkFiles(path.join(backendDir, 'routes'), /\.js$/);
  const expressRouteMap = new Map(); // handlerName -> [ { method, fullPath, subPath, file, line } ]

  for (const rFile of routeFiles) {
    const ast = parseFile(rFile);
    if (!ast) continue;

    const basePrefix = filePrefixMap[rFile] || (rFile.includes('health') ? '/health' : '');

    traverse(ast, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (callee?.type === 'MemberExpression' && (callee.object.name === 'router' || callee.object.name === 'app')) {
          const method = callee.property.name.toUpperCase();
          if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
            const pathArg = p.node.arguments[0];
            let subPath = '';
            if (pathArg?.type === 'StringLiteral') subPath = pathArg.value;
            else if (pathArg?.type === 'TemplateLiteral') {
              subPath = pathArg.quasis.map((q, i) => {
                const expr = pathArg.expressions[i];
                const exprName = expr?.name ? `:${expr.name}` : ':param';
                return q.value.raw + (i < pathArg.expressions.length ? exprName : '');
              }).join('');
            }

            if (subPath !== undefined) {
              const fullPath = (basePrefix + (subPath === '/' ? '' : subPath)).replace(/\/+/g, '/');
              for (let i = 1; i < p.node.arguments.length; i++) {
                const arg = p.node.arguments[i];
                const hName = arg.name || (arg.type === 'MemberExpression' && arg.property.name);
                if (hName) {
                  if (!expressRouteMap.has(hName)) expressRouteMap.set(hName, []);
                  expressRouteMap.get(hName).push({
                    method,
                    fullPath,
                    subPath,
                    file: path.relative(backendDir, rFile),
                    line: p.node.loc.start.line
                  });
                }
              }
            }
          }
        }
      }
    });
  }
  return expressRouteMap;
}

// ── 4. Client API Scanner (Frontend & Admin) ────────────────────────────────
function scanClientApis(clientDirs) {
  const clientApiExports = []; // { app, apiFunc, url, method, file, line }

  for (const { app, dir } of clientDirs) {
    if (!fs.existsSync(dir)) continue;
    const apiFiles = walkFiles(dir, /\.(js|ts)$/).filter(f => f.includes('/api/') || f.includes('/Api/'));

    for (const f of apiFiles) {
      const code = fs.readFileSync(f, 'utf8');
      const ast = parseFile(f);
      if (!ast) continue;

      const consts = {};
      traverse(ast, {
        VariableDeclaration(p) {
          for (const decl of p.node.declarations) {
            if (decl.id?.name && decl.init?.type === 'StringLiteral') {
              consts[decl.id.name] = decl.init.value;
            }
          }
        }
      });

      traverse(ast, {
        ExportNamedDeclaration(p) {
          let exportName = null;
          let line = null;
          let targetExpr = null;
          if (p.node.declaration?.type === 'VariableDeclaration') {
            exportName = p.node.declaration.declarations[0]?.id?.name;
            line = p.node.declaration.loc.start.line;
            targetExpr = p.node.declaration.declarations[0]?.init;
          } else if (p.node.declaration?.type === 'FunctionDeclaration') {
            exportName = p.node.declaration.id.name;
            line = p.node.declaration.loc.start.line;
            targetExpr = p.node.declaration.body;
          }
          if (!exportName || !targetExpr) return;

          p.traverse({
            CallExpression(cp) {
              const callee = cp.node.callee;
              let method = null;
              let isApiCall = false;
              if (callee.type === 'MemberExpression') {
                const objName = callee.object.name;
                const propName = callee.property.name;
                if (['api', 'axios', 'authApi'].includes(objName) && ['get', 'post', 'put', 'delete', 'patch'].includes(propName)) {
                  method = propName.toUpperCase();
                  isApiCall = true;
                }
              } else if (callee.name === 'fetch') {
                method = 'GET';
                isApiCall = true;
              } else if (callee.name && (callee.name.includes('stream') || callee.name.includes('SSE') || callee.name.includes('Stream') || callee.name.includes('fetch') || callee.name.includes('request'))) {
                method = 'POST';
                isApiCall = true;
              }

              const arg0 = cp.node.arguments[0];
              const isPathArg = arg0?.type === 'StringLiteral' && arg0.value.startsWith('/');
              const isTemplatePath = arg0?.type === 'TemplateLiteral' && (arg0.quasis[0]?.value?.raw?.startsWith('/') || arg0.quasis[0]?.value?.raw === '');

              if (isApiCall || (isPathArg || isTemplatePath)) {
                if (!method) method = 'POST';
                let resolvedUrl = '';
                if (arg0?.type === 'StringLiteral') resolvedUrl = arg0.value;
                else if (arg0?.type === 'TemplateLiteral') {
                  resolvedUrl = arg0.quasis.map((q, i) => {
                    const expr = arg0.expressions[i];
                    let exprVal = ':param';
                    if (expr) {
                      if (expr.type === 'Identifier') {
                        exprVal = consts[expr.name] !== undefined ? consts[expr.name] : `{${expr.name}}`;
                      } else if (expr.type === 'MemberExpression') {
                        exprVal = `{${expr.property.name}}`;
                      }
                    }
                    return q.value.raw + (i < arg0.expressions.length ? exprVal : '');
                  }).join('');
                }

                if (resolvedUrl) {
                  let fullUrl = resolvedUrl;
                  if (!fullUrl.startsWith('/api') && fullUrl.startsWith('/')) {
                    fullUrl = '/api' + fullUrl;
                  }
                  clientApiExports.push({
                    app,
                    apiFunc: exportName,
                    url: fullUrl,
                    rawUrl: resolvedUrl,
                    method,
                    file: path.relative(dir, f),
                    line
                  });
                }
              }
            }
          });
        }
      });
    }
  }
  return clientApiExports;
}

// ── 5. Client UI Component Scanner ──────────────────────────────────────────
function scanClientUi(clientDirs, clientApiExports) {
  const uiUsages = []; // { app, apiFunc, component, callerFunc, file, line, snippet }

  for (const { app, dir } of clientDirs) {
    if (!fs.existsSync(dir)) continue;
    const compFiles = walkFiles(dir, /\.(jsx?|tsx?)$/).filter(f => !f.includes('/api/') && !f.includes('/Api/'));

    for (const f of compFiles) {
      const code = fs.readFileSync(f, 'utf8');
      const matchedApis = clientApiExports.filter(e => e.app === app && code.includes(e.apiFunc));
      if (matchedApis.length === 0) continue;

      const ast = parseFile(f);
      if (!ast) continue;

      const importedApis = new Set();
      traverse(ast, {
        ImportDeclaration(p) {
          for (const spec of p.node.specifiers) {
            if (matchedApis.some(m => m.apiFunc === spec.local.name)) {
              importedApis.add(spec.local.name);
            }
          }
        }
      });

      if (importedApis.size === 0) continue;

      const compName = path.basename(f, path.extname(f));

      traverse(ast, {
        Identifier(p) {
          const name = p.node.name;
          if (
            name &&
            importedApis.has(name) &&
            p.key !== 'imported' &&
            p.key !== 'local' &&
            p.parentPath.node.type !== 'ImportSpecifier'
          ) {
            let cur = p.parentPath;
            let callerFunc = null;
            while (cur && !['FunctionDeclaration', 'ArrowFunctionExpression', 'FunctionExpression'].includes(cur.node.type)) {
              cur = cur.parentPath;
            }
            if (cur) {
              if (cur.node.id) {
                callerFunc = cur.node.id.name;
              } else if (cur.parentPath?.node?.type === 'VariableDeclarator') {
                callerFunc = cur.parentPath.node.id?.name;
              }
            }

            const startLine = p.node.loc.start.line;
            const lines = code.split('\n');
            const snippet = lines.slice(Math.max(0, startLine - 3), Math.min(lines.length, startLine + 3)).join('\n');

            // Dedup by component + apiFunc + callerFunc + line
            if (!uiUsages.some(u => u.app === app && u.component === compName && u.apiFunc === name && u.line === startLine)) {
              uiUsages.push({
                app,
                apiFunc: name,
                component: compName,
                callerFunc: callerFunc || 'component_body',
                file: path.relative(dir, f),
                line: startLine,
                snippet
              });
            }
          }
        }
      });
    }
  }
  return uiUsages;
}

// ── 6. Correlate and Build Full Lineage Graph ───────────────────────────────
function buildLineageGraph(brainEndpoints, serviceCalls, controllerMap, expressRouteMap, clientApiExports, uiUsages) {
  const chains = [];

  for (const ep of brainEndpoints) {
    const domain = ep.path.split('/')[1] || 'root';

    // 1. Find backend service calls matching this brain endpoint
    const matchingServices = serviceCalls.filter(sc => {
      return pathsMatch(sc.cleanPath, ep.path) || pathsMatch(ep.path, sc.cleanPath);
    });

    const backendBridges = [];

    for (const sc of matchingServices) {
      const controllers = controllerMap.get(sc.serviceFunc) || [];
      if (controllers.length === 0) {
        backendBridges.push({
          service: sc,
          controller: null,
          routes: []
        });
      } else {
        for (const ctrl of controllers) {
          const routes = expressRouteMap.get(ctrl.controllerFunc) || [];
          backendBridges.push({
            service: sc,
            controller: ctrl,
            routes
          });
        }
      }
    }

    // 2. Find client APIs matching any of the backend express routes
    const clientBridges = [];
    const matchedExpressRoutes = backendBridges.flatMap(b => b.routes);

    for (const er of matchedExpressRoutes) {
      const apis = clientApiExports.filter(ca => {
        return pathsMatch(ca.url, er.fullPath) || pathsMatch(er.fullPath, ca.url) || pathsMatch(ca.rawUrl, er.subPath);
      });

      for (const api of apis) {
        const usages = uiUsages.filter(u => u.app === api.app && u.apiFunc === api.apiFunc);
        clientBridges.push({
          app: api.app,
          api,
          ui: usages
        });
      }
    }

    // Determine status
    let status = 'unexposed';
    const hasUi = clientBridges.some(cb => cb.ui && cb.ui.length > 0);
    const hasClientApi = clientBridges.length > 0;
    const hasRoute = backendBridges.some(b => b.routes && b.routes.length > 0);
    const hasService = backendBridges.length > 0;

    if (hasUi) status = 'full_chain';
    else if (hasClientApi) status = 'client_api';
    else if (hasRoute) status = 'backend_exposed';
    else if (hasService) status = 'service_only';

    chains.push({
      id: ep.id,
      method: ep.method,
      path: ep.path,
      domain,
      endpoint: ep,
      backend: backendBridges,
      clients: clientBridges,
      status,
      stats: {
        services_count: backendBridges.length,
        routes_count: matchedExpressRoutes.length,
        client_apis_count: clientBridges.length,
        ui_usages_count: clientBridges.reduce((acc, c) => acc + (c.ui?.length || 0), 0)
      }
    });
  }

  // Summary statistics
  const summary = {
    total_brain_endpoints: chains.length,
    full_chain_count: chains.filter(c => c.status === 'full_chain').length,
    client_api_count: chains.filter(c => c.status === 'client_api').length,
    backend_exposed_count: chains.filter(c => c.status === 'backend_exposed').length,
    service_only_count: chains.filter(c => c.status === 'service_only').length,
    unexposed_count: chains.filter(c => c.status === 'unexposed').length,
    admin_connected_count: chains.filter(c => c.clients.some(cl => cl.app === 'admin')).length,
    frontend_connected_count: chains.filter(c => c.clients.some(cl => cl.app === 'frontend')).length
  };

  return { chains, summary };
}

// ── Main Runner ─────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const opts = parseArgs();
  const dirs = resolveDirectories(opts);

  let brainEndpoints = [];
  if (opts.endpointsJson && fs.existsSync(opts.endpointsJson)) {
    try {
      const content = fs.readFileSync(opts.endpointsJson, 'utf8');
      const data = JSON.parse(content);
      brainEndpoints = data.endpoints || (data.groups ? data.groups.flatMap(g => g.endpoints) : []);
    } catch (e) {}
  }

  // If endpoints not supplied, try fetching from running Brain Terminal API
  if (brainEndpoints.length === 0) {
    try {
      const res = await fetch('http://127.0.0.1:8011/viewer/routes');
      if (res.ok) {
        const data = await res.json();
        brainEndpoints = data.endpoints || (data.groups ? data.groups.flatMap(g => g.endpoints) : []);
      }
    } catch (e) {}
  }

  const clientDirs = [
    { app: 'admin', dir: dirs.adminDir },
    { app: 'frontend', dir: dirs.frontendDir }
  ];

  const serviceCalls = scanBackendServices(dirs.backendDir);
  const controllerMap = scanBackendControllers(dirs.backendDir, serviceCalls);
  const expressRouteMap = scanBackendRoutes(dirs.backendDir);
  const clientApiExports = scanClientApis(clientDirs);
  const uiUsages = scanClientUi(clientDirs, clientApiExports);

  const { chains, summary } = buildLineageGraph(
    brainEndpoints,
    serviceCalls,
    controllerMap,
    expressRouteMap,
    clientApiExports,
    uiUsages
  );

  const durationMs = Date.now() - t0;
  const outputData = {
    timestamp: Date.now(),
    duration_ms: durationMs,
    directories: {
      brain: dirs.brainDir,
      backend: dirs.backendDir,
      frontend: dirs.frontendDir,
      admin: dirs.adminDir
    },
    summary,
    chains
  };

  if (opts.output) {
    fs.writeFileSync(opts.output, JSON.stringify(outputData, null, 2), 'utf8');
  } else {
    process.stdout.write(JSON.stringify(outputData));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  scanBackendServices,
  scanBackendControllers,
  scanBackendRoutes,
  scanClientApis,
  scanClientUi,
  buildLineageGraph
};
