import { useState } from "react";
import { gql, useMutation, useQuery } from "@apollo/client";
import { session, type IssueStatus } from "./client";

const ME = gql`query Me { me { id name email } }`;

const SIGN_IN = gql`
  mutation SignIn($input: SignInInput!) { signIn(input: $input) { token refreshToken user { id name } } }
`;
const SIGN_UP = gql`
  mutation SignUp($input: SignUpInput!) { signUp(input: $input) { token refreshToken user { id name } } }
`;

const SIGN_OUT = gql`
  mutation SignOut($t: String!) { signOut(token: $t) }
`;

const WORKSPACES = gql`
  query Workspaces { workspaces { id name slug role issueCount } }
`;

const ISSUES = gql`
  query Issues($workspaceId: ID!, $status: IssueStatus) {
    issues(workspaceId: $workspaceId, first: 20, status: $status) {
      edges { cursor node { id title status priority commentCount createdAt author { name } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CREATE_ISSUE = gql`
  mutation CreateIssue($input: CreateIssueInput!) {
    createIssue(input: $input) { id title status }
  }
`;

const SET_STATUS = gql`
  mutation SetStatus($id: ID!, $status: IssueStatus!) {
    setIssueStatus(id: $id, status: $status) { id status }
  }
`;

const NEXT: Record<IssueStatus, IssueStatus> = {
  OPEN: "IN_PROGRESS",
  IN_PROGRESS: "DONE",
  DONE: "OPEN",
};

export function App() {
  const [token, setToken] = useState(session.access);
  const [signOut] = useMutation(SIGN_OUT);

  async function handleSignOut() {
    const refresh = session.refresh;
    if (refresh) {
      try {
        await signOut({ variables: { t: refresh } });
      } catch {
        // Local sign-out must succeed even if the network does not.
      }
    }
    session.clear();
    setToken(null);
  }

  if (!token) return <Auth onToken={setToken} />;
  return <Board onSignOut={handleSignOut} />;
}

function Auth({ onToken }: { onToken: (t: string) => void }) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [signIn] = useMutation(SIGN_IN);
  const [signUp] = useMutation(SIGN_UP);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const vars = { input: mode === "in" ? { email, password } : { email, name, password } };
      const res = mode === "in" ? await signIn({ variables: vars }) : await signUp({ variables: vars });
      const payload = res.data?.signIn ?? res.data?.signUp;
      if (!payload) throw new Error(res.errors?.[0]?.message ?? "Sign in failed");
      session.set(payload.token, payload.refreshToken);
      onToken(payload.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: "10vh auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>IssueFlow</h1>
      <p style={{ color: "#555" }}>Multi-tenant issue tracking on GraphQL.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        {mode === "up" && (
          <input required placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <input required type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input required type="password" placeholder="Password (8+ chars)" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        <button type="submit">{mode === "in" ? "Sign in" : "Create account"}</button>
      </form>
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
      <button onClick={() => setMode(mode === "in" ? "up" : "in")} style={{ marginTop: 12 }}>
        {mode === "in" ? "Need an account?" : "Have an account?"}
      </button>
    </main>
  );
}

function Board({ onSignOut }: { onSignOut: () => void }) {
  const me = useQuery(ME);
  const spaces = useQuery(WORKSPACES);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const active = workspaceId ?? spaces.data?.workspaces?.[0]?.id ?? null;

  return (
    <main style={{ maxWidth: 860, margin: "4vh auto", fontFamily: "system-ui" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 22 }}>IssueFlow {me.data?.me ? `· ${me.data.me.name}` : ""}</h1>
        <button onClick={onSignOut}>Sign out</button>
      </header>
      {spaces.loading && <p>Loading workspaces…</p>}
      {!spaces.loading && spaces.data?.workspaces?.length === 0 && (
        <p>No workspace yet. Create one through the API, then reload.</p>
      )}
      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        {spaces.data?.workspaces?.map((w: { id: string; name: string; role: string }) => (
          <button key={w.id} onClick={() => setWorkspaceId(w.id)}
            style={{ fontWeight: w.id === active ? 700 : 400 }}>
            {w.name} <small>({w.role})</small>
          </button>
        ))}
      </div>
      {active && <Issues workspaceId={active} />}
    </main>
  );
}

function Issues({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<IssueStatus | undefined>();
  const { data, loading, refetch } = useQuery(ISSUES, { variables: { workspaceId, status } });
  const [createIssue] = useMutation(CREATE_ISSUE);
  const [setIssueStatus] = useMutation(SET_STATUS);
  const [title, setTitle] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await createIssue({ variables: { input: { workspaceId, title, body: "Filed from the web client" } } });
    setTitle("");
    refetch();
  }

  return (
    <section>
      <form onSubmit={add} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input style={{ flex: 1 }} placeholder="New issue title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit">File issue</button>
      </form>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[undefined, "OPEN", "IN_PROGRESS", "DONE"].map((s) => (
          <button key={s ?? "all"} onClick={() => setStatus(s as IssueStatus | undefined)}
            style={{ fontWeight: status === s ? 700 : 400 }}>{s ?? "All"}</button>
        ))}
      </div>
      {loading && <p>Loading…</p>}
      {data?.issues?.edges?.map(({ node }: { node: { id: string; title: string; status: IssueStatus; priority: number; commentCount: number; author: { name: string } } }) => (
        <article key={node.id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <strong>{node.title}</strong>
            <button onClick={async () => { await setIssueStatus({ variables: { id: node.id, status: NEXT[node.status] } }); refetch(); }}>
              {node.status}
            </button>
          </div>
          <small style={{ color: "#666" }}>
            {node.author.name} · P{node.priority} · {node.commentCount} comment{node.commentCount === 1 ? "" : "s"}
          </small>
        </article>
      ))}
      {data?.issues?.edges?.length === 0 && <p>No issues in this view.</p>}
    </section>
  );
}
