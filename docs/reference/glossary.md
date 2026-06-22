---
title: "Glossary"
description: "Canonical meanings for eve runtime, protocol, and authorization terms."
---

## Agent

The authored identity and capability tree rooted at `agent/`. One application has one root agent and may declare child subagents.

## Model

The AI SDK-compatible language model configured in `agent.ts`. A gateway model ID and a direct provider model are two routing forms of the same field.

## Harness

The framework-owned model loop and built-in tools. Application code extends the harness; it does not implement the loop.

## Runtime

The trusted eve server process that owns model calls, authored tool execution, credentials, durable workflow coordination, and channel routes.

## Session

A durable conversation or task containing ordered turns, history, session state, and sandbox state. Public APIs identify it with `sessionId`.

## Turn

One inbound user message or input response and all work it triggers until the session waits, completes, or fails.

## Step

A durable execution checkpoint inside a turn, commonly one model call and its requested actions. An interrupted, incomplete step may run again.

## Continuation token

The opaque value required to deliver a follow-up or input response to the session's current wait point. It is not a session ID or a general message queue address.

## Session ID

The public identifier used to address a durable session and subscribe to its stream. Use `runId` only when an underlying workflow API explicitly exposes a separate run concept.

## Channel

An inbound and outbound transport adapter. A channel verifies provider requests, derives caller identity, maps transport conversations to eve sessions, and presents responses or human input.

## Connection

A declared MCP server or OpenAPI service whose remote operations become qualified model tools. Connection credentials remain in the server runtime.

## Approval

A human-input gate evaluated before a tool executes. Approval records intent; it is not authentication, authorization, or idempotency.

## Authentication

Proof of who a caller or service is. Route authentication creates the caller principal; connection authentication obtains outbound service credentials.

## Authorization

The policy decision that an authenticated principal may perform an action or access a resource. Applications enforce tenant, resource, and tool authorization outside the model.

## Workspace

The logical `/workspace` filesystem visible inside an agent's sandbox. Seeded files and skill packages appear there.

## Sandbox

The isolated execution backend that implements `/workspace`, commands, processes, and optional egress controls. Authored tool functions run in the server runtime unless they explicitly call the sandbox.
