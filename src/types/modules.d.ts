declare module "osprey" {
  interface OspreyRouter {
    use(...args: any[]): OspreyRouter;
    post(path: string, ...handlers: any[]): OspreyRouter;
    get(path: string, ...handlers: any[]): OspreyRouter;
    (req: any, res: any, next?: any): void;
    [key: string]: any;
  }

  function osprey(): any;

  namespace osprey {
    function Router(): OspreyRouter;
    function errorHandler(): any;
  }

  export default osprey;
  export = osprey;
}

declare module "osprey-resources" {
  function resources(
    resources: any[],
    handler: (route: any) => any
  ): any;

  export default resources;
  export = resources;
}
