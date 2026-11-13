import {
  ApolloClient,
  ApolloLink,
  HttpLink,
  InMemoryCache,
  Observable,
  concat,
  from,
} from "@apollo/client";
import { onError } from "@apollo/client/link/error";

export type IssueStatus = "OPEN" | "IN_PROGRESS" | "DONE";

const ACCESS_KEY = "issueflow.token";
const REFRESH_KEY = "issueflow.refresh";
const REFRESH_MUTATION = `mutation Refresh($t: String!) { refreshSession(token: $t) { token refreshToken } }`;

export const session = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

/**
 * One refresh in flight at a time. Ten parallel queries hitting an expired token must produce
 * one rotation, not ten: rotation revokes the presented token, so a second concurrent call
 * would look like replay and kill the family.
 */
let inFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const token = session.refresh;
  if (!token) return false;
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const res = await fetch("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: REFRESH_MUTATION, variables: { t: token } }),
        });
        const body = await res.json();
        const payload = body?.data?.refreshSession;
        if (!payload?.token) return false;
        session.set(payload.token, payload.refreshToken);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => {
          inFlight = null;
        }, 0);
      }
    })();
  }
  return inFlight;
}

const errorLink = onError(({ graphQLErrors, operation, forward }) => {
  const expired = graphQLErrors?.some((e) => e.extensions?.code === "UNAUTHENTICATED");
  if (!expired || !session.refresh) return;
  return new Observable((observer) => {
    let sub: { unsubscribe: () => void } | undefined;
    refreshSession().then((ok) => {
      if (!ok) {
        session.clear();
        observer.error(new Error("Session expired"));
        return;
      }
      sub = forward(operation).subscribe(observer);
    });
    return () => sub?.unsubscribe();
  });
});

const authLink = new ApolloLink((operation, forward) => {
  const token = localStorage.getItem("issueflow.token");
  operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
    headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers,
  }));
  return forward(operation);
});

export const client = new ApolloClient({
  link: from([errorLink, concat(authLink, new HttpLink({ uri: "/graphql" }))]),
  cache: new InMemoryCache({
    typePolicies: {
      Query: { fields: { issues: { merge: false } } },
    },
  }),
});

export type IssueStatus = "OPEN" | "IN_PROGRESS" | "DONE";
