import { Syntax } from 'estraverse';
import * as esrecurse from 'esrecurse';
import { Reference } from './reference';
import { VariableType } from './variable';
import { PatternVisitor } from './patternVisitor';
import { Definition, ParameterDefinition } from './definition';
import * as assert from 'assert';
import { ScopeManager } from './scopeManager';
import { Scope, ModuleScope } from './scope';
import { ExportInfo, ExportType } from './exportInfo';

/**
 * Traverse identifier in pattern
 * @param {Object} options - options
 * @param {pattern} rootPattern - root pattern
 * @param {Refencer} referencer - referencer
 * @param {callback} callback - callback
 * @returns {void}
 */
function traverseIdentifierInPattern(
  options,
  rootPattern,
  referencer,
  callback,
) {
  // Call the callback at left hand identifier nodes, and Collect right hand nodes.
  const visitor = new PatternVisitor(options, rootPattern, callback);

  visitor.visit(rootPattern);

  // Process the right hand nodes recursively.
  if (referencer !== null && referencer !== undefined) {
    visitor.rightHandNodes.forEach(referencer.visit, referencer);
  }
}

// Importing ImportDeclaration.
// http://people.mozilla.org/~jorendorff/es6-draft.html#sec-moduledeclarationinstantiation
// https://github.com/estree/estree/blob/master/es6.md#importdeclaration
// FIXME: Now, we don't create module environment, because the context is
// implementation dependent.

class Importer extends esrecurse.Visitor {

  public declaration: any;
  public referencer: Referencer;
  public visit: Function;

  constructor(declaration, referencer: Referencer) {
    super(null, referencer.options);
    this.declaration = declaration;
    this.referencer = referencer;
  }

  visitImport(id, specifier) {
    (this.referencer as any).visitPattern(id, pattern => {
      this.referencer
        .currentScope()
        .__define(
          pattern,
          new Definition(
            VariableType.ImportBinding,
            pattern,
            specifier,
            this.declaration,
            null,
            null,
          ),
        );
    });
  }

  ImportNamespaceSpecifier(node) {
    const local = node.local || node.id;

    if (local) {
      this.visitImport(local, node);
    }
  }

  ImportDefaultSpecifier(node) {
    const local = node.local || node.id;

    this.visitImport(local, node);
  }

  ImportSpecifier(node) {
    const local = node.local || node.id;

    if (node.name) {
      this.visitImport(node.name, node);
    } else {
      this.visitImport(local, node);
    }
  }
}

// Referencing variables and creating bindings.
export class Referencer extends esrecurse.Visitor {

  public options: any;
  public scopeManager: ScopeManager;
  public parent: Referencer;
  public isInnerMethodDefinition: boolean;

  public visit: Function;

  constructor(options, scopeManager) {
    super(null, options);
    this.options = options;
    this.scopeManager = scopeManager;
    this.parent = null;
    this.isInnerMethodDefinition = false;
  }

  currentScope() {
    return this.scopeManager.__currentScope;
  }

  close(node) {
    while (this.currentScope() && node === this.currentScope().block) {
      this.scopeManager.__currentScope = this.currentScope().__close(
        this.scopeManager,
      );
    }
  }

  pushInnerMethodDefinition(isInnerMethodDefinition) {
    const previous = this.isInnerMethodDefinition;

    this.isInnerMethodDefinition = isInnerMethodDefinition;
    return previous;
  }

  popInnerMethodDefinition(isInnerMethodDefinition) {
    this.isInnerMethodDefinition = isInnerMethodDefinition;
  }

  materializeTDZScope(node, iterationNode) {
    // http://people.mozilla.org/~jorendorff/es6-draft.html#sec-runtime-semantics-forin-div-ofexpressionevaluation-abstract-operation
    // TDZ scope hides the declaration's names.
    this.scopeManager.__nestTDZScope(node);
    this.visitVariableDeclaration(
      this.currentScope(),
      VariableType.TDZ,
      iterationNode.left,
      0,
      true,
    );
  }

  materializeIterationScope(node) {
    // Generate iteration scope for upper ForIn/ForOf Statements.
    const letOrConstDecl = node.left;

    this.scopeManager.__nestForScope(node);
    (this as any).visitVariableDeclaration(
      this.currentScope(),
      VariableType.Variable,
      letOrConstDecl,
      0,
    );
    (this as any).visitPattern(letOrConstDecl.declarations[0].id, pattern => {
      this.currentScope().__referencing(
        pattern,
        Reference.WRITE,
        node.right,
        null,
        true,
        true,
      );
    });
  }

  referencingDefaultValue(pattern, assignments, maybeImplicitGlobal, init) {
    const scope = this.currentScope();

    assignments.forEach(assignment => {
      scope.__referencing(
        pattern,
        Reference.WRITE,
        assignment.right,
        maybeImplicitGlobal,
        pattern !== assignment.left,
        init,
      );
    });
  }

  visitPattern(node, options: any, callback?) {
    if (typeof options === 'function') {
      callback = options;
      options = { processRightHandNodes: false };
    }
    traverseIdentifierInPattern(
      this.options,
      node,
      options.processRightHandNodes ? this : null,
      callback,
    );
  }

  visitFunction(node) {
    let i, iz;

    // FunctionDeclaration name is defined in upper scope
    // NOTE: Not referring variableScope. It is intended.
    // Since
    //  in ES5, FunctionDeclaration should be in FunctionBody.
    //  in ES6, FunctionDeclaration should be block scoped.

    if (node.type === Syntax.FunctionDeclaration) {
      // id is defined in upper scope
      this.currentScope().__define(
        node.id,
        new Definition(VariableType.FunctionName, node.id, node, null, null, null),
      );
    }

    // FunctionExpression with name creates its special scope;
    // FunctionExpressionNameScope.
    if (node.type === Syntax.FunctionExpression && node.id) {
      this.scopeManager.__nestFunctionExpressionNameScope(node);
    }

    // Consider this function is in the MethodDefinition.
    this.scopeManager.__nestFunctionScope(node, this.isInnerMethodDefinition);

    const that = this;

    /**
     * Visit pattern callback
     * @param {pattern} pattern - pattern
     * @param {Object} info - info
     * @returns {void}
     */
    function visitPatternCallback(pattern, info) {
      that
        .currentScope()
        .__define(
          pattern,
          new ParameterDefinition(pattern, node, i, info.rest),
        );

      that.referencingDefaultValue(pattern, info.assignments, null, true);
    }

    // Process parameter declarations.
    for (i = 0, iz = node.params.length; i < iz; ++i) {
      this.visitPattern(
        node.params[i],
        { processRightHandNodes: true },
        visitPatternCallback,
      );
    }

    // if there's a rest argument, add that
    if (node.rest) {
      this.visitPattern(
        {
          type: 'RestElement',
          argument: node.rest,
        },
        pattern => {
          this.currentScope().__define(
            pattern,
            new ParameterDefinition(pattern, node, node.params.length, true),
          );
        },
      );
    }

    // In TypeScript there are a number of function-like constructs which have no body,
    // so check it exists before traversing
    if (node.body) {
      // Skip BlockStatement to prevent creating BlockStatement scope.
      if (node.body.type === Syntax.BlockStatement) {
        (this as any).visitChildren(node.body);
      } else {
        (this as any).visit(node.body);
      }
    }

    this.close(node);
  }

  visitClass(node) {
    if (node.type === Syntax.ClassDeclaration) {
      this.currentScope().__define(
        node.id,
        new Definition(VariableType.ClassName, node.id, node, null, null, null),
      );
    }

    // FIXME: Maybe consider TDZ.
    (this as any).visit(node.superClass);

    this.scopeManager.__nestClassScope(node);

    if (node.id) {
      this.currentScope().__define(
        node.id,
        new Definition(VariableType.ClassName, node.id, node),
      );
    }
    (this as any).visit(node.body);

    this.close(node);
  }

  visitProperty(node) {
    let previous;

    if (node.computed) {
      (this as any).visit(node.key);
    }

    const isMethodDefinition = node.type === Syntax.MethodDefinition;

    if (isMethodDefinition) {
      previous = this.pushInnerMethodDefinition(true);
    }
    (this as any).visit(node.value);
    if (isMethodDefinition) {
      this.popInnerMethodDefinition(previous);
    }
  }

  visitForIn(node) {
    if (
      node.left.type === Syntax.VariableDeclaration &&
      node.left.kind !== 'var'
    ) {
      this.materializeTDZScope(node.right, node);
      this.visit(node.right);
      this.close(node.right);

      this.materializeIterationScope(node);
      this.visit(node.body);
      this.close(node);
    } else {
      if (node.left.type === Syntax.VariableDeclaration) {
        this.visit(node.left);
        this.visitPattern(node.left.declarations[0].id, pattern => {
          this.currentScope().__referencing(
            pattern,
            Reference.WRITE,
            node.right,
            null,
            true,
            true,
          );
        });
      } else {
        this.visitPattern(
          node.left,
          { processRightHandNodes: true },
          (pattern, info) => {
            let maybeImplicitGlobal = null;

            if (!this.currentScope().isStrict) {
              maybeImplicitGlobal = {
                pattern,
                node,
              };
            }
            this.referencingDefaultValue(
              pattern,
              info.assignments,
              maybeImplicitGlobal,
              false,
            );
            this.currentScope().__referencing(
              pattern,
              Reference.WRITE,
              node.right,
              maybeImplicitGlobal,
              true,
              false,
            );
          },
        );
      }
      this.visit(node.right);
      this.visit(node.body);
    }
  }

  visitVariableDeclaration(variableTargetScope, type, node, index, fromTDZ) {
    // If this was called to initialize a TDZ scope, this needs to make definitions, but doesn't make references.
    const decl = node.declarations[index];
    const init = decl.init;

    this.visitPattern(
      decl.id,
      { processRightHandNodes: !fromTDZ },
      (pattern, info) => {
        variableTargetScope.__define(
          pattern,
          new Definition(type, pattern, decl, node, index, node.kind),
        );

        if (!fromTDZ) {
          this.referencingDefaultValue(pattern, info.assignments, null, true);
        }
        if (init) {
          this.currentScope().__referencing(
            pattern,
            Reference.WRITE,
            init,
            null,
            !info.topLevel,
            true,
          );
        }
      },
    );
  }

  AssignmentExpression(node) {
    if (PatternVisitor.isPattern(node.left)) {
      if (node.operator === '=') {
        this.visitPattern(
          node.left,
          { processRightHandNodes: true },
          (pattern, info) => {
            let maybeImplicitGlobal = null;

            if (!this.currentScope().isStrict) {
              maybeImplicitGlobal = {
                pattern,
                node,
              };
            }
            this.referencingDefaultValue(
              pattern,
              info.assignments,
              maybeImplicitGlobal,
              false,
            );
            this.currentScope().__referencing(
              pattern,
              Reference.WRITE,
              node.right,
              maybeImplicitGlobal,
              !info.topLevel,
              false,
            );
          },
        );
      } else {
        this.currentScope().__referencing(node.left, Reference.RW, node.right);
      }
    } else {
      this.visit(node.left);
    }
    this.visit(node.right);
  }

  CatchClause(node) {
    this.scopeManager.__nestCatchScope(node);

    this.visitPattern(
      node.param,
      { processRightHandNodes: true },
      (pattern, info) => {
        this.currentScope().__define(
          pattern,
          new Definition(
            VariableType.CatchClause,
            node.param,
            node,
            null,
            null,
            null,
          ),
        );
        this.referencingDefaultValue(pattern, info.assignments, null, true);
      },
    );
    this.visit(node.body);

    this.close(node);
  }

  Program(node) {
    this.scopeManager.__nestGlobalScope(node);

    if (this.scopeManager.__isNodejsScope()) {
      // Force strictness of GlobalScope to false when using node.js scope.
      this.currentScope().isStrict = false;
      this.scopeManager.__nestFunctionScope(node, false);
    }

    if (this.scopeManager.__isES6() && this.scopeManager.isModule()) {
      this.scopeManager.__nestModuleScope(node);
    }

    if (
      this.scopeManager.isStrictModeSupported() &&
      this.scopeManager.isImpliedStrict()
    ) {
      this.currentScope().isStrict = true;
    }

    (this as any).visitChildren(node);
    this.close(node);
  }

  Identifier(node) {
    this.currentScope().__referencing(node);
  }

  UpdateExpression(node) {
    if (PatternVisitor.isPattern(node.argument)) {
      this.currentScope().__referencing(node.argument, Reference.RW, null);
    } else {
      (this as any).visitChildren(node);
    }
  }

  MemberExpression(node) {
    this.visit(node.object);
    if (node.computed) {
      this.visit(node.property);
    }
  }

  Property(node) {
    this.visitProperty(node);
  }

  MethodDefinition(node) {
    this.visitProperty(node);
  }

  BreakStatement() {} // eslint-disable-line class-methods-use-this

  ContinueStatement() {} // eslint-disable-line class-methods-use-this

  LabeledStatement(node) {
    this.visit(node.body);
  }

  ForStatement(node) {
    // Create ForStatement declaration.
    // NOTE: In ES6, ForStatement dynamically generates
    // per iteration environment. However, escope is
    // a static analyzer, we only generate one scope for ForStatement.
    if (
      node.init &&
      node.init.type === Syntax.VariableDeclaration &&
      node.init.kind !== 'var'
    ) {
      this.scopeManager.__nestForScope(node);
    }

    (this as any).visitChildren(node);

    this.close(node);
  }

  ClassExpression(node) {
    this.visitClass(node);
  }

  ClassDeclaration(node) {
    this.visitClass(node);
  }

  CallExpression(node) {
    // Check this is direct call to eval
    if (
      !this.scopeManager.__ignoreEval() &&
      node.callee.type === Syntax.Identifier &&
      node.callee.name === 'eval'
    ) {
      // NOTE: This should be `variableScope`. Since direct eval call always creates Lexical environment and
      // let / const should be enclosed into it. Only VariableDeclaration affects on the caller's environment.
      this.currentScope().variableScope.__detectEval();
    }
    (this as any).visitChildren(node);
  }

  BlockStatement(node) {
    if (this.scopeManager.__isES6()) {
      this.scopeManager.__nestBlockScope(node);
    }

    (this as any).visitChildren(node);

    this.close(node);
  }

  ThisExpression() {
    this.currentScope().variableScope.__detectThis();
  }

  WithStatement(node) {
    this.visit(node.object);

    // Then nest scope for WithStatement.
    this.scopeManager.__nestWithScope(node);

    this.visit(node.body);

    this.close(node);
  }

  VariableDeclaration(node) {
    const variableTargetScope =
      node.kind === 'var'
        ? this.currentScope().variableScope
        : this.currentScope();

    for (let i = 0, iz = node.declarations.length; i < iz; ++i) {
      const decl = node.declarations[i];

      (this as any).visitVariableDeclaration(
        variableTargetScope,
        VariableType.Variable,
        node,
        i,
      );
      if (decl.init) {
        this.visit(decl.init);
      }
    }
  }

  // sec 13.11.8
  SwitchStatement(node) {
    this.visit(node.discriminant);

    if (this.scopeManager.__isES6()) {
      this.scopeManager.__nestSwitchScope(node);
    }

    for (let i = 0, iz = node.cases.length; i < iz; ++i) {
      this.visit(node.cases[i]);
    }

    this.close(node);
  }

  FunctionDeclaration(node) {
    this.visitFunction(node);
  }

  FunctionExpression(node) {
    this.visitFunction(node);
  }

  ForOfStatement(node) {
    this.visitForIn(node);
  }

  ForInStatement(node) {
    this.visitForIn(node);
  }

  ArrowFunctionExpression(node) {
    this.visitFunction(node);
  }

  ImportDeclaration(node) {
    assert(
      this.scopeManager.__isES6() && this.scopeManager.isModule(),
      'ImportDeclaration should appear when the mode is ES6 and in the module context.',
    );

    const importer = new Importer(node, this);

    importer.visit(node);
  }

  visitExportDeclaration(node, isDefault) {
    const moduleScope = this.scopeManager.__currentScope;
    if (moduleScope.type !== 'module') {
      throw new Error('Export declaration must be used in module scope');
    }

    if (node.source) {
      return;
    }
    if (node.declaration) {
      this.visit(node.declaration);
      return;
    }

    (this as any).visitChildren(node);
  }

  ExportDeclaration(node) {
    this.visitExportDeclaration(node, false);
  }

  ExportNamedDeclaration(node) {
    if (node.declaration) {
      debugger;
      // this.startExport(ExportInfo.ExportType.named);
      // this.visitExportDeclaration(node, false);
      // this.finishExport();
    } else {
      const specifiers = node.specifiers;
      const source = node.source ? node.source.value : null;
      specifiers.forEach(item => {
        this.visitExportSpecifier(item, source);
      });
    }
  }

  visitExportSpecifier(node, source) {
    const currentScope = this.currentScope();
    if (currentScope.type !== 'module') {
      throw new Error('use export in a non module scope');
    }

    const localName = node.local.name;
    const exportedName = node.exported.name;

    // let exportInfo;
    // if (exportedName === 'default') {
    //   exportInfo = this.startExport(ExportInfo.ExportType.default);
    // } else {
    //   exportInfo = this.startExport(ExportInfo.ExportType.named);
    // }
    // exportInfo.source = source;
    // exportInfo.alias = localName;

    this.visit(node);
    // this.finishExport();
  }

  ExportDefaultDeclaration(node) {
    // const exportInfo = this.startExport(ExportInfo.ExportType.default);
    const currentScope = this.currentScope();
    if (currentScope.type !== 'module') {
      throw new Error('use export in a non module scope');
    }
    // exportInfo.alias = 'default';
    if (node.declaration.type === 'AssignmentExpression') {
      const decl = node.declaration;
      currentScope.__define(
        decl.left,
        new Definition(
          VariableType.ExportDefault,
          decl.left.name,
          decl,
          node,
          null,
          null,
        ),
      );
    }
    this.visitExportDeclaration(node, true);
    // this.finishExport();
  }

  // ExportAllDeclaration(node) {
    // const info = this.startExport(ExportType.all);
    // info.source = node.source.value;
    // this.finishExport();
  // }

  // startExport(exportType: ExportType) {
  //   const currentScope = this.currentScope() as ModuleScope;
  //   if (currentScope.type !== 'module') {
  //     throw new Error('use export in a non module scope');
  //   }
  //   return currentScope.startExport(exportType);
  // }

  // finishExport() {
  //   const currentScope = this.currentScope() as ModuleScope;
  //   if (currentScope.type !== 'module') {
  //     throw new Error('use export in a non module scope');
  //   }

  //   return currentScope.finishExport();
  // }

  ExportSpecifier(node) {
    const local = node.id || node.local;

    this.visit(local);
  }

  MetaProperty() {
    // eslint-disable-line class-methods-use-this
    // do nothing.
  }
}