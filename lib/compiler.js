/*
 * This file uses webpack to compile a template with a child compiler.
 *
 * [TEMPLATE] -> [JAVASCRIPT]
 *
 */
'use strict';
var Promise = require('bluebird');
var _ = require('lodash');
var path = require('path');
var NodeTemplatePlugin = require('webpack/lib/node/NodeTemplatePlugin');
var NodeTargetPlugin = require('webpack/lib/node/NodeTargetPlugin');
var LoaderTargetPlugin = require('webpack/lib/LoaderTargetPlugin');
var LibraryTemplatePlugin = require('webpack/lib/LibraryTemplatePlugin');
var SingleEntryPlugin = require('webpack/lib/SingleEntryPlugin');
/**
 * Compiles the template into a nodejs factory, adds its to the compilation.assets
 * and returns a promise of the result asset object.
 *
 * @param template relative path to the template file
 * @param context path context
 * @param outputFilename the file name
 * @param compilation The webpack compilation object
 *
 * Returns an object:
 * {
 *  hash: {String} - Base64 hash of the file
 *  content: {String} - Javascript executable code of the template
 * }
 *
 */
 //调用方式：childCompiler.compileTemplate(self.options.template, compiler.context, self.options.filename, compilation)
module.exports.compileTemplate = function compileTemplate (template, context, outputFilename, compilation) {
  // The entry file is just an empty helper as the dynamic template
  // require is added in "loader.js"
  var outputOptions = {
    filename: outputFilename,
    publicPath: compilation.outputOptions.publicPath
  };
  // Store the result of the parent compilation before we start the child compilation
  var assetsBeforeCompilation = _.assign({}, compilation.assets[outputOptions.filename]);
  //文件名称
  // Create an additional child compiler which takes the template
  // and turns it into an Node.JS html factory.
  // This allows us to use loaders during the compilation
  var compilerName = getCompilerName(context, outputFilename);
  //Returns the child compiler name e.g. 'html-webpack-plugin for "index.html"'
  var childCompiler = compilation.createChildCompiler(compilerName, outputOptions);
  //创建childCompiler的时候传入filename和publicPath
  childCompiler.context = context;
  //childCompiler的上下文和原来的上下文是一样的
  childCompiler.apply(
    new NodeTemplatePlugin(outputOptions),
    new NodeTargetPlugin(),
    new LibraryTemplatePlugin('HTML_WEBPACK_PLUGIN_RESULT', 'var'),
    new SingleEntryPlugin(this.context, template),
    new LoaderTargetPlugin('node')
  );

  // Fix for "Uncaught TypeError: __webpack_require__(...) is not a function"
  // Hot module replacement requires that every child compiler has its own
  // cache. @see https://github.com/ampedandwired/html-webpack-plugin/pull/179
  childCompiler.plugin('compilation', function (compilation) {
    if (compilation.cache) {
      if (!compilation.cache[compilerName]) {
        compilation.cache[compilerName] = {};
      }
      //compilation.cache中存放的是该compilerName的结果
      compilation.cache = compilation.cache[compilerName];
    }
  });

  // Compile and return a promise
  return new Promise(function (resolve, reject) {
    childCompiler.runAsChild(function (err, entries, childCompilation) {
      // Resolve / reject the promise
      if (childCompilation && childCompilation.errors && childCompilation.errors.length) {
        var errorDetails = childCompilation.errors.map(function (error) {
          return error.message + (error.error ? ':\n' + error.error : '');
        }).join('\n');
        reject(new Error('Child compilation failed:\n' + errorDetails));
        //如果报错，直接reject
      } else if (err) {
        reject(err);
      } else {
        // Replace [hash] placeholders in filename
        var outputName = compilation.mainTemplate.applyPluginsWaterfall('asset-path', outputOptions.filename, {
          hash: childCompilation.hash,
          chunk: entries[0]
        });
        //替换其中的hash值

        // Restore the parent compilation to the state like it
        // was before the child compilation
        compilation.assets[outputName] = assetsBeforeCompilation[outputName];
        //重新装载

        if (assetsBeforeCompilation[outputName] === undefined) {
          // If it wasn't there - delete it
          delete compilation.assets[outputName];
        }
        //这个promise可以resolve
        resolve({
          // Hash of the template entry point
          //入口文件的hash
          hash: entries[0].hash,
          // Output name
          outputName: outputName,
          // Compiled code
          content: childCompilation.assets[outputName].source()
          //文件内容已经编译好了，放在content里面
        });
      }
    });
  });
};

/**
 * Returns the child compiler name e.g. 'html-webpack-plugin for "index.html"'
 调用方式：getCompilerName(context, outputFilename);
 */
function getCompilerName (context, filename) {
  var absolutePath = path.resolve(context, filename);
  //获取当前文件的绝对路径
  var relativePath = path.relative(context, absolutePath);
  //path.relative(from, to)，将from的文件路径转化为相对于to的相对路径
  return 'html-webpack-plugin for "' + (absolutePath.length < relativePath.length ? absolutePath : relativePath) + '"';
  //获取相对路径和绝对路径中较短的一个
}
