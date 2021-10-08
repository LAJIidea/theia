/********************************************************************************
 * Copyright (C) 2021 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as ts from 'typescript';
import * as os from 'os';
import * as path from 'path';
import { glob, IOptions } from 'glob';
import deepmerge = require('deepmerge');

export interface Localization {
    [key: string]: string | Localization
}

export interface ExtractionOptions {
    root: string
    output: string
    exclude?: string
    logs?: string
    pattern?: string
    merge: boolean
}

class SingleFileServiceHost implements ts.LanguageServiceHost {

    private file: ts.IScriptSnapshot;
    private lib: ts.IScriptSnapshot;

    constructor(private options: ts.CompilerOptions, private filename: string, contents: string) {
        this.file = ts.ScriptSnapshot.fromString(contents);
        this.lib = ts.ScriptSnapshot.fromString('');
    }

    getCompilationSettings = () => this.options;
    getScriptFileNames = () => [this.filename];
    getScriptVersion = () => '1';
    getScriptSnapshot = (name: string) => name === this.filename ? this.file : this.lib;
    getCurrentDirectory = () => '';
    getDefaultLibFileName = () => 'lib.d.ts';
}

class TypeScriptError extends Error {
    constructor(message: string, node: ts.Node) {
        super(buildErrorMessage(message, node));
    }
}

function buildErrorMessage(message: string, node: ts.Node): string {
    const source = node.getSourceFile();
    const sourcePath = source.fileName;
    const pos = source.getLineAndCharacterOfPosition(node.pos);
    return `${sourcePath}(${pos.line + 1},${pos.character + 1}): ${message}`;
}

const tsOptions: ts.CompilerOptions = {
    noResolve: true,
    allowJs: true
};

function globPromise(pattern: string, options: IOptions): Promise<string[]> {
    return new Promise((resolve, reject) => {
        glob(pattern, options, (err, matches) => {
            if (err) {
                reject(err);
            } else {
                resolve(matches);
            }
        });
    });
}

export async function extract(options: ExtractionOptions): Promise<void> {
    const cwd = path.resolve(process.cwd(), options.root);
    const files = await globPromise(options.pattern || '**/src/**/*.ts', { cwd });
    let localization: Localization = {};
    const errors: string[] = [];
    for (const file of files) {
        const fileLocalization = await extractFromFile(path.resolve(cwd, file), options, errors);
        localization = deepmerge(localization, fileLocalization);
    }
    if (errors.length > 0 && options.logs) {
        await fs.promises.writeFile(options.logs, errors.join(os.EOL));
    }
    const output = path.resolve(process.cwd(), options.output);
    if (options.merge && await fs.pathExists(output)) {
        const existing = await fs.readJson(output);
        localization = deepmerge(existing, localization);
    }
    await fs.writeJson(options.output, localization, {
        spaces: 4
    });
}

export async function extractFromFile(file: string, options: ExtractionOptions, errors: string[]): Promise<Localization> {
    const content = await fs.promises.readFile(file, { encoding: 'utf8' });
    const serviceHost = new SingleFileServiceHost(tsOptions, file, content);
    const service = ts.createLanguageService(serviceHost);
    const sourceFile = service.getProgram()!.getSourceFile(file)!;
    const localization: Localization = {};
    const localizationCalls = collect(sourceFile, node => isLocalizeCall(node));
    for (const call of localizationCalls) {
        try {
            const extracted = extractFromLocalizeCall(call);
            if (!isExcluded(options, extracted[0])) {
                insert(localization, extracted[0], extracted[1]);
            }
        } catch (err) {
            const tsError = err as Error;
            errors.push(tsError.message);
            console.log(tsError.message);
        }
    }
    const localizedCommands = collect(sourceFile, node => isCommandLocalizeUtility(node));
    for (const command of localizedCommands) {
        try {
            const extracted = extractFromLocalizedCommandCall(command);
            const label = extracted.label;
            const category = extracted.category;
            if (!isExcluded(options, label[0])) {
                insert(localization, label[0], label[1]);
            }
            if (category && !isExcluded(options, category[0])) {
                insert(localization, category[0], category[1]);
            }
        } catch (err) {
            const tsError = err as Error;
            errors.push(tsError.message);
            console.log(tsError.message);
        }
    }
    return localization;
}

function isExcluded(options: ExtractionOptions, key: string): boolean {
    return !!options.exclude && key.startsWith(options.exclude);
}

function insert(localization: Localization, key: string, value: string): void {
    const parts = key.split('/');
    parts.forEach((part, i) => {
        let entry = localization[part];
        if (i === parts.length - 1) {
            if (typeof entry === 'object') {
                throw new Error(`Multiple tranlation keys already exist at '${key}'`);
            }
            localization[part] = value;
        } else {
            if (typeof entry === 'string') {
                throw new Error(`String entry already exists at '${parts.splice(0, i + 1).join('/')}'`);
            }
            if (!entry) {
                entry = {};
            }
            localization[part] = entry;
            localization = entry;
        }
    });
}

function collect(n: ts.Node, fn: (node: ts.Node) => boolean): ts.Node[] {
    const result: ts.Node[] = [];

    function loop(node: ts.Node): void {

        const stepResult = fn(node);

        if (stepResult) {
            result.push(node);
        } else {
            ts.forEachChild(node, loop);
        }
    }

    loop(n);
    return result;
}

function isLocalizeCall(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) {
        return false;
    }

    return node.expression.getText() === 'nls.localize';
}

function extractFromLocalizeCall(node: ts.Node): [string, string] {
    if (!ts.isCallExpression(node)) {
        throw new TypeScriptError('Invalid node type', node);
    }
    const args = node.arguments;

    if (args.length < 2) {
        throw new TypeScriptError('Localize call needs at least 2 arguments', node);
    }

    const key = extractString(args[0]);
    const value = extractString(args[1]);
    return [key, value];
}

function extractFromLocalizedCommandCall(node: ts.Node): { label: [string, string], category?: [string, string] } {
    if (!ts.isCallExpression(node)) {
        throw new TypeScriptError('Invalid node type', node);
    }
    const args = node.arguments;

    if (args.length < 1) {
        throw new TypeScriptError('Localize call needs at least 2 arguments', node);
    }

    const commandObj = args[0];

    if (!ts.isObjectLiteralExpression(commandObj)) {
        throw new TypeScriptError('First argument of "toLocalizedCommand" needs to be an object literal', node);
    }

    const properties = commandObj.properties;
    const propertyMap = new Map<string, string>();
    const relevantProps = ['id', 'label', 'category'];

    for (const property of properties) {
        if (!property.name) {
            continue;
        }
        if (!ts.isPropertyAssignment(property)) {
            throw new TypeScriptError('Only property assignments in "toLocalizedCommand" are allowed', property);
        }
        if (!ts.isIdentifier(property.name)) {
            throw new TypeScriptError('Only identifiers are allowed in "toLocalizedCommand"', property);
        }
        const name = property.name.text;
        if (!relevantProps.includes(property.name.text)) {
            continue;
        }

        const value = extractString(property.initializer);
        propertyMap.set(name, value);
    }

    let labelKey = propertyMap.get('id');
    let categoryKey: string | undefined = undefined;

    // We have an explicit label translation key
    if (args.length > 1) {
        labelKey = extractString(args[1]) || labelKey;
    }

    // We have an explicit category translation key
    if (args.length > 2) {
        categoryKey = extractString(args[2]);
    }

    if (!labelKey) {
        throw new TypeScriptError('No label key found', node);
    }

    if (!propertyMap.get('label')) {
        throw new TypeScriptError('No default label found', node);
    }

    let categoryLocalization: [string, string] | undefined = undefined;
    const categoryLabel = propertyMap.get('category');
    if (categoryKey && categoryLabel) {
        categoryLocalization = [categoryKey, categoryLabel];
    }

    return {
        label: [labelKey, propertyMap.get('label')!],
        category: categoryLocalization
    };
}

function extractString(node: ts.Expression): string {
    if (!ts.isStringLiteral(node)) {
        throw new TypeScriptError(`'${node.getText()}' is not a string constant`, node);
    }

    return unescapeString(node.text);
}

function isCommandLocalizeUtility(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) {
        return false;
    }

    return node.expression.getText() === 'Command.toLocalizedCommand';
}

const unescapeMap: Record<string, string> = {
    '\'': '\'',
    '"': '"',
    '\\': '\\',
    'n': '\n',
    'r': '\r',
    't': '\t',
    'b': '\b',
    'f': '\f'
};

function unescapeString(str: string): string {
    const result: string[] = [];
    for (let i = 0; i < str.length; i++) {
        const ch = str.charAt(i);
        if (ch === '\\') {
            if (i + 1 < str.length) {
                const replace = unescapeMap[str.charAt(i + 1)];
                if (replace !== undefined) {
                    result.push(replace);
                    i++;
                    continue;
                }
            }
        }
        result.push(ch);
    }
    return result.join('');
}
