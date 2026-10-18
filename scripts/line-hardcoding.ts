// M12 기준 6: notify 말풍선 문장은 plugins/*/lines.json 에만 둔다. 소스에서 `text` 에 정적 문장이나 문장 합성을
// 넣는 패턴을 TypeScript 컴파일러 API 로 찾는다. 배지·버튼·로그·detail 은 검사하지 않는다.
import ts from "typescript";

export interface Violation { line: number; reason: string }

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    /\.[cm]?js$/u.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
         ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

function constants(file: ts.SourceFile): Map<string, ts.Expression> {
  const found = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) found.set(node.name.text, node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** True when the expression contributes a fixed sentence: a literal, a template with literal parts, or a helper/concatenation using one. */
function fixedText(node: ts.Expression, known: Map<string, ts.Expression>, seen: ReadonlySet<string> = new Set()): boolean {
  const expression = unwrap(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text.trim() !== "";
  if (ts.isTemplateExpression(expression))
    return expression.head.text.trim() !== "" || expression.templateSpans.some((span) => span.literal.text.trim() !== "");
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken)
      return fixedText(expression.left, known, seen) || fixedText(expression.right, known, seen);
    return false;
  }
  if (ts.isConditionalExpression(expression))
    return fixedText(expression.whenTrue, known, seen) || fixedText(expression.whenFalse, known, seen);
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.some((item) => fixedText(item, known, seen));
  if (ts.isCallExpression(expression)) {
    const receiver = ts.isPropertyAccessExpression(expression.expression) ? expression.expression.expression : undefined;
    return (receiver !== undefined && fixedText(receiver, known, seen)) ||
      expression.arguments.some((item) => fixedText(item, known, seen));
  }
  if (ts.isIdentifier(expression)) {
    const initializer = known.get(expression.text);
    if (initializer === undefined || seen.has(expression.text)) return false;
    return fixedText(initializer, known, new Set([...seen, expression.text]));
  }
  return false;
}

const propertyName = (property: ts.ObjectLiteralElementLike): string | undefined =>
  property.name !== undefined && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;

const calleeName = (call: ts.CallExpression): string => call.expression.getText().replace(/\s+/gu, "");

/** An object literal that builds a PetEvent: it is emitted, assigned into an event, or has source/type fields. */
function eventLike(object: ts.ObjectLiteralExpression): boolean {
  const type = object.properties.find((item) => propertyName(item) === "type");
  if (type !== undefined && ts.isPropertyAssignment(type)) {
    const value = unwrap(type.initializer);
    if (ts.isStringLiteral(value)) return value.text === "notify";
  }
  if (object.properties.some((item) => propertyName(item) === "source")) return true;
  const parent = object.parent;
  if (ts.isCallExpression(parent)) {
    const name = calleeName(parent);
    if (name === "emit" || name.endsWith(".emit")) return true;
    if (name === "Object.assign") {
      const target = parent.arguments[0];
      return target !== undefined && target !== object && /event/iu.test(target.getText());
    }
  }
  return false;
}

export function findHardcodedBubbleText(source: string, fileName = "source.ts"): Violation[] {
  const file = parse(source, fileName);
  const known = constants(file);
  const found: Violation[] = [];
  const report = (node: ts.Node, reason: string): void => {
    found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, reason });
  };
  const flagTextArgument = (item: ts.Node, next: ts.Expression | undefined): void => {
    if (ts.isStringLiteral(item) && item.text === "--text" && next !== undefined && fixedText(next, known))
      report(item, "--text 인자에 정적 문장이나 문장 합성이 있습니다 (--line 을 쓰세요)");
  };
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && eventLike(node)) {
      for (const property of node.properties) {
        if (propertyName(property) !== "text") continue;
        if (ts.isPropertyAssignment(property) && fixedText(property.initializer, known))
          report(property, "notify text 에 정적 문장이나 문장 합성이 있습니다 (line 으로 옮기세요)");
        else if (ts.isShorthandPropertyAssignment(property) && fixedText(property.name, known))
          report(property, "notify text 에 정적 문장이 있습니다 (line 으로 옮기세요)");
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) && node.left.name.text === "text" &&
        /event/iu.test(node.left.expression.getText()) && fixedText(node.right, known))
      report(node, "event.text 에 정적 문장이나 문장 합성을 대입했습니다 (line 으로 옮기세요)");
    // 훅: deskpet event 인자에 `--text <문장>` 을 넣는 패턴.
    if (ts.isArrayLiteralExpression(node)) node.elements.forEach((item, index) => flagTextArgument(item, node.elements[index + 1]));
    if (ts.isCallExpression(node) && calleeName(node).endsWith(".push"))
      node.arguments.forEach((item, index) => flagTextArgument(item, node.arguments[index + 1]));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Line ids a source selects (a template id keeps `*` for each substitution): `line: { id }` in plugins, any `{ id }` record in the hook selector. */
export function findLineIds(source: string, fileName = "source.ts", options: { anyIdProperty?: boolean } = {}): string[] {
  const file = parse(source, fileName);
  const ids = new Set<string>();
  const literals = (node: ts.Expression): void => {
    const expression = unwrap(node);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ids.add(expression.text);
    else if (ts.isTemplateExpression(expression))
      ids.add(expression.head.text + expression.templateSpans.map((span) => `*${span.literal.text}`).join(""));
    else if (ts.isConditionalExpression(expression)) { literals(expression.whenTrue); literals(expression.whenFalse); }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && propertyName(node) === "id") {
      const owner = node.parent.parent;
      const inLine = ts.isPropertyAssignment(owner) && propertyName(owner) === "line";
      if (inLine || options.anyIdProperty === true) literals(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...ids].sort();
}
