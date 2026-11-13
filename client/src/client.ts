import { ApolloClient, ApolloLink, HttpLink, InMemoryCache, concat } from "@apollo/client";

const authLink = new ApolloLink((operation, forward) => {
  const token = localStorage.getItem("issueflow.token");
  operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
    headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers,
  }));
  return forward(operation);
});

export const client = new ApolloClient({
  link: concat(authLink, new HttpLink({ uri: "/graphql" })),
  cache: new InMemoryCache({
    typePolicies: {
      Query: { fields: { issues: { merge: false } } },
    },
  }),
});

export type IssueStatus = "OPEN" | "IN_PROGRESS" | "DONE";
