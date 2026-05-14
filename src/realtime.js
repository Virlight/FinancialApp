import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

const clients = new Map();
const jobs = new Map();

export function attachRealtime(server) {
  const wss = new WebSocketServer({
    server,
    path: "/ws"
  });

  wss.on("connection", (socket) => {
    const clientId = randomUUID();

    clients.set(clientId, {
      clientId,
      socket,
      connectedAt: new Date().toISOString()
    });

    sendSocket(socket, {
      type: "ws_connected",
      clientId,
      serverTime: new Date().toISOString(),
      jobs: getClientJobs(clientId)
    });

    socket.on("message", (rawMessage) => {
      handleClientMessage(clientId, rawMessage);
    });

    socket.on("close", () => {
      clients.delete(clientId);
    });
  });

  return wss;
}

export function createRealtimeJob({ clientId, type, label, metadata = {} }) {
  if (!clientId || !clients.has(clientId)) {
    return null;
  }

  const now = new Date().toISOString();
  const abortController = new AbortController();
  const job = {
    id: `job_${Date.now()}_${randomUUID().slice(0, 8)}`,
    clientId,
    type,
    label,
    status: "running",
    metadata,
    events: [],
    abortController,
    createdAt: now,
    updatedAt: now
  };

  jobs.set(job.id, job);
  sendJobEvent(job, "job_started", {
    job: serializeJob(job)
  });

  return job;
}

export function emitRealtimeJobProgress(job, { stage, message, data = null }) {
  if (!job || !jobs.has(job.id)) {
    return;
  }

  const storedJob = jobs.get(job.id);

  if (storedJob.status !== "running") {
    return;
  }

  const event = {
    stage,
    message,
    data,
    createdAt: new Date().toISOString()
  };

  storedJob.events.push(event);
  storedJob.updatedAt = event.createdAt;
  sendJobEvent(storedJob, "job_progress", {
    jobId: storedJob.id,
    status: storedJob.status,
    ...event
  });
}

export function emitRealtimeLlmToken(job, { text, accumulatedText = null }) {
  if (!job || !jobs.has(job.id) || !text) {
    return;
  }

  const storedJob = jobs.get(job.id);

  if (storedJob.status !== "running") {
    return;
  }

  storedJob.updatedAt = new Date().toISOString();
  sendJobEvent(storedJob, "llm_token", {
    jobId: storedJob.id,
    status: storedJob.status,
    text,
    accumulatedText,
    createdAt: storedJob.updatedAt
  });
}

export function completeRealtimeJob(job, result = {}) {
  finishRealtimeJob(job, "completed", "job_completed", {
    result
  });
}

export function failRealtimeJob(job, error) {
  finishRealtimeJob(job, "failed", "job_failed", {
    error: error?.message || String(error || "Job failed")
  });
}

export function cancelRealtimeJob(jobId, { clientId, reason = "cancelled_by_user" } = {}) {
  const job = jobs.get(jobId);

  if (!job || (clientId && job.clientId !== clientId)) {
    return null;
  }

  if (job.status !== "running") {
    return job;
  }

  job.abortController.abort(reason);
  finishRealtimeJob(job, "cancelled", "job_cancelled", {
    reason
  });

  return job;
}

export function throwIfRealtimeJobCancelled(job) {
  if (job?.abortController?.signal?.aborted || job?.status === "cancelled") {
    const error = new Error("Realtime job was cancelled by the user.");
    error.code = "realtime_job_cancelled";
    throw error;
  }
}

export function getRealtimeSnapshot() {
  return {
    clients: clients.size,
    jobs: [...jobs.values()].map(serializeJob)
  };
}

function finishRealtimeJob(job, status, eventType, payload) {
  if (!job || !jobs.has(job.id)) {
    return;
  }

  const storedJob = jobs.get(job.id);

  if (storedJob.status !== "running" && storedJob.status !== status) {
    return;
  }

  storedJob.status = status;
  storedJob.updatedAt = new Date().toISOString();
  sendJobEvent(storedJob, eventType, {
    jobId: storedJob.id,
    status,
    ...payload
  });
}

function handleClientMessage(clientId, rawMessage) {
  let message = null;

  try {
    message = JSON.parse(String(rawMessage || ""));
  } catch {
    sendToClient(clientId, {
      type: "ws_error",
      error: "invalid_json"
    });
    return;
  }

  if (message.type === "cancel_job") {
    const job = cancelRealtimeJob(String(message.jobId || ""), {
      clientId,
      reason: "cancelled_by_user"
    });

    if (!job) {
      sendToClient(clientId, {
        type: "ws_error",
        error: "job_not_found",
        jobId: message.jobId || null
      });
    }

    return;
  }

  if (message.type === "ping") {
    sendToClient(clientId, {
      type: "pong",
      serverTime: new Date().toISOString()
    });
  }
}

function sendJobEvent(job, type, payload) {
  sendToClient(job.clientId, {
    type,
    ...payload
  });
}

function sendToClient(clientId, payload) {
  const client = clients.get(clientId);

  if (!client) {
    return;
  }

  sendSocket(client.socket, payload);
}

function sendSocket(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function getClientJobs(clientId) {
  return [...jobs.values()]
    .filter((job) => job.clientId === clientId && job.status === "running")
    .map(serializeJob);
}

function serializeJob(job) {
  return {
    id: job.id,
    type: job.type,
    label: job.label,
    status: job.status,
    metadata: job.metadata,
    events: job.events.slice(-20),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}
