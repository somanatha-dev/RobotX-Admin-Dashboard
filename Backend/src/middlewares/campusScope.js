"use strict";

/**
 * RBAC — per-resource campus checks for ADMIN-capable routes that name one robot or task.
 *
 * Run before anything else that reads the resource (the retired-robot check included), so a
 * caller outside the resource's campus gets the same 404 as for an identifier that does not
 * exist, and learns nothing about which it was. A SUPER_ADMIN passes without a query.
 */

const { getPrisma } = require("../db/prisma");
const { toStringOrNull } = require("../utils/parse");
const accessScope = require("../services/accessScope.service");

function scopeOf(req) {
  return req.access ?? accessScope.accessScopeFor(req.user);
}

function invalidScope(res, scope) {
  return res.status(403).json({ ok: false, error: "Forbidden", refusal: "INVALID_SCOPE", detail: scope.reason || "no valid access scope" });
}

/**
 * @param {string} [param] the route parameter naming the robot's business id
 * @param {{ deferInvalid?: boolean }} [options] `deferInvalid` passes a caller with no valid
 *   scope on to the gates that follow instead of refusing it here. Only for the §23.4
 *   action-class routes, whose gate must be the one that decides — and audits — that refusal.
 * @returns {import("express").RequestHandler}
 */
function robotParamInScope(param = "robotId", options = {}) {
  return async function robotInScope(req, res, next) {
    const scope = scopeOf(req);
    if (accessScope.isSuperAdmin(scope)) return next();
    if (scope.kind !== accessScope.SCOPE.CAMPUS) return options.deferInvalid ? next() : invalidScope(res, scope);
    try {
      await accessScope.robotInScopeOrThrow(getPrisma(), scope, toStringOrNull(req.params?.[param]));
      return next();
    } catch (error) {
      if (error.status === 404) return res.status(404).json({ ok: false, error: "Unknown robotId", message: "Unknown robotId" });
      return next(error);
    }
  };
}

/**
 * @param {string} [param] the route parameter naming the task's business id
 * @returns {import("express").RequestHandler}
 */
function taskParamInScope(param = "taskId") {
  return async function taskInScope(req, res, next) {
    const scope = scopeOf(req);
    if (accessScope.isSuperAdmin(scope)) return next();
    if (scope.kind !== accessScope.SCOPE.CAMPUS) return invalidScope(res, scope);
    try {
      await accessScope.taskInScopeOrThrow(getPrisma(), scope, toStringOrNull(req.params?.[param]));
      return next();
    } catch (error) {
      if (error.status === 404) return res.status(404).json({ ok: false, error: "Unknown taskId", message: "Unknown taskId" });
      return next(error);
    }
  };
}

module.exports = { robotParamInScope, taskParamInScope };
