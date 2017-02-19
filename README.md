### 1.chunk.files

```js
 var chunkFiles = [].concat(chunk.files).map(function (chunkFile) {
      return publicPath + chunkFile;
    });
```

这个插件是依赖的webpack 1.14.0:

```js
 "webpack": "^1.14.0",
```

### 2.添加输出资源

```js
HtmlWebpackPlugin.prototype.addFileToAssets = function (filename, compilation) {
  filename = path.resolve(compilation.compiler.context, filename);
  //获取文件的绝对路径
  return Promise.props({
    size: fs.statAsync(filename),
    source: fs.readFileAsync(filename)
  })
  .catch(function () {
    return Promise.reject(new Error('HtmlWebpackPlugin: could not load file ' + filename));
  })
  .then(function (results) {
    var basename = path.basename(filename);
    //path.basename('/foo/bar/baz/asdf/quux.html')
     // Returns: 'quux.html'
     //获取文件名称
    compilation.fileDependencies.push(filename);
    //在compilation.fileDependencies中添加文件，filename是完整的文件路径
    compilation.assets[basename] = {
      source: function () {
        return results.source;
      },
      //source是文件的内容，通过fs.readFileAsync完成
      size: function () {
        return results.size.size;
        //size通过 fs.statAsync(filename)完成
      }
    };
    return basename;
  });
};
```

可以自动添加文件了。

### 3.如何获取publicPath

```js
 var publicPath = typeof compilation.options.output.publicPath !== 'undefined'
    // If a hard coded public path exists use it
    ? compilation.mainTemplate.getPublicPath({hash: webpackStatsJson.hash})
    // If no public path was set get a relative url path
    : path.relative(path.resolve(compilation.options.output.path, path.dirname(self.childCompilationOutputName)), compilation.options.output.path)
      .split(path.sep).join('/');
    //得到publicpath

    if (publicPath.length && publicPath.substr(-1, 1) !== '/') {
      publicPath += '/';
    }
```



