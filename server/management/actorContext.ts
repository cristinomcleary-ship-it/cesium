import type { IncomingMessage } from "node:http";
import type { Actor } from "./domain.ts";
/** A server-only side channel. No header or payload field can supply this identity. */
const trustedActors = new WeakMap<IncomingMessage, Actor>();
export function setManagementActor(req: IncomingMessage, actor: Actor): void { trustedActors.set(req, actor); }
export function managementActor(req: IncomingMessage): Actor | undefined { return trustedActors.get(req); }

/** Classify saved library records without accepting a client-supplied role or permission. */
export function managementResourceReadable(actor: Actor | undefined, kind: string): boolean {
 if (!actor) return true; // Standalone legacy host; managed host always attaches an authenticated actor first.
 if (actor.taskIds) return false;
 const permission = ["3D Tiles","Model","Imagery"].includes(kind) ? "models" : kind === "Drone Video" ? "media" : ["CAD","GIS"].includes(kind) ? "files" : undefined;
 return permission ? actor.permissions.includes(permission) : ["models","files","media"].every(p=>actor.permissions.includes(p as "models"|"files"|"media"));
}
