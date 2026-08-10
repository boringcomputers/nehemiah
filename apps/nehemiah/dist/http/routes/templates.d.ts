import { type TemplateService } from '../../domain/templates.js';
import { type AuthServices } from '../auth.js';
import { type Router } from '../router.js';
export interface TemplateRouteServices extends AuthServices {
    readonly templates: TemplateService;
}
export declare const registerTemplateRoutes: <S extends TemplateRouteServices>(router: Router<S>) => void;
