import {
  GraphQLError,
  Kind,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
} from "graphql";
import type { ApolloServerPlugin } from "@apollo/server";
import type { Context } from "./context.js";

/**
 * Depth limit as a validation gate, not a resolver-level band-aid.
 *
 * GraphQL lets a client ask for `issues { author { issues { author { ... } } } }`, which a
 * naive schema will happily answer with an exponential number of queries. The limit is
 * applied after the document resolves (so fragment spreads are already resolved) and
 * before execution starts, so a hostile query costs one parse and zero database work.
 *
 * Introspection fields are excluded: `__typename` appears at every level and carries no cost.
 */
export function depthLimitPlugin(maxDepth = Number(process.env.MAX_QUERY_DEPTH ?? 8)): ApolloServerPlugin<Context> {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ document }) {
          const depth = documentDepth(document);
          if (depth > maxDepth) {
            throw new GraphQLError(`Query depth ${depth} exceeds the limit of ${maxDepth}`, {
              extensions: { code: "QUERY_TOO_DEEP", depth, maxDepth },
            });
          }
        },
      };
    },
  };
}

export function documentDepth(document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  let max = 0;
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) {
      max = Math.max(max, selectionDepth(def.selectionSet, fragments, new Set()));
    }
  }
  return max;
}

function selectionDepth(
  selectionSet: SelectionSetNode,
  fragments: Map<string, FragmentDefinitionNode>,
  seen: Set<string>,
): number {
  let max = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (selection.name.value.startsWith("__")) continue;
      const child = selection.selectionSet ? selectionDepth(selection.selectionSet, fragments, seen) : 0;
      max = Math.max(max, 1 + child);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      max = Math.max(max, selectionDepth(selection.selectionSet, fragments, seen));
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      if (seen.has(name)) continue;
      const fragment = fragments.get(name);
      if (fragment) {
        max = Math.max(max, selectionDepth(fragment.selectionSet, fragments, new Set([...seen, name])));
      }
    }
  }
  return max;
}
