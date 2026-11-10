"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

exports.version = 1;
exports.name = "import-meta-url";

/**
 * Rewrites `import.meta` meta-property expressions into `{ url: ... }` during CommonJS `ts-jest` execution
 * so browser ESM modules like `src/dashboard/store.ts` run under Jest/JSDOM without module mocking.
 *
 * @param {import("ts-jest").TsCompilerInstance} tsCompiler
 */
function factory({ configSet }) {
  const ts = configSet.compilerModule;
  return (ctx) => {
    const visitor = (node) => {
      if (
        ts.isMetaProperty(node) &&
        node.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.name.text === "meta"
      ) {
        return ts.factory.createObjectLiteralExpression([
          ts.factory.createPropertyAssignment(
            "url",
            ts.factory.createPropertyAccessExpression(
              ts.factory.createCallExpression(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createCallExpression(
                    ts.factory.createIdentifier("require"),
                    undefined,
                    [ts.factory.createStringLiteral("node:url")]
                  ),
                  "pathToFileURL"
                ),
                undefined,
                [ts.factory.createIdentifier("__filename")]
              ),
              "href"
            )
          ),
        ]);
      }
      return ts.visitEachChild(node, visitor, ctx);
    };
    return (sf) => ts.visitNode(sf, visitor);
  };
}

exports.factory = factory;

